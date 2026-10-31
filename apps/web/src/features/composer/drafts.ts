import { create } from 'zustand'
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware'

export const composerDraftKey = (hostKey: string, draftId: string) =>
  JSON.stringify([hostKey, draftId])

interface NewSessionDestination {
  hostKey: string
  folder: string
}

const STORAGE_KEY = 'beddcode.composer-drafts'
const WRITE_DELAY_MS = 400

/** localStorage that waits for typing to pause, and writes at once when the page is left. */
function debouncedStorage(): StateStorage {
  let pending: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (pending === undefined) return
    const value = pending
    pending = undefined
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, value)
    } catch {
      // Still works for this window.
    }
  }
  globalThis.addEventListener?.('pagehide', flush)
  return {
    getItem: (name) => {
      try {
        return globalThis.localStorage?.getItem(name) ?? null
      } catch {
        return null
      }
    },
    setItem: (_name, value) => {
      pending = value
      clearTimeout(timer)
      timer = setTimeout(flush, WRITE_DELAY_MS)
    },
    removeItem: (name) => {
      pending = undefined
      clearTimeout(timer)
      try {
        globalThis.localStorage?.removeItem(name)
      } catch {
        // Nothing saved to remove.
      }
    },
  }
}

/** Text stays with its chat or new-session folder while navigating, and across restarts. */
export const useComposerDrafts = create<{
  drafts: Record<string, string>
  lastNewSession?: NewSessionDestination
  rememberNewSession(destination: NewSessionDestination): void
  setDraft(key: string, text: string): void
  restoreDraft(key: string, text: string): void
  /** Forgets the drafts of sessions that no longer exist. */
  dropDrafts(keys: string[]): void
}>()(
  persist(
    (set) => ({
      drafts: {},
      rememberNewSession: (lastNewSession) => set({ lastNewSession }),
      setDraft: (key, text) =>
        set((s) => {
          const drafts = { ...s.drafts }
          if (text) drafts[key] = text
          else delete drafts[key]
          return { drafts }
        }),
      // A send can fail after navigating away. Keep the words without replacing a newer draft.
      restoreDraft: (key, text) =>
        set((s) => (s.drafts[key] ? s : { drafts: { ...s.drafts, [key]: text } })),
      dropDrafts: (keys) =>
        set((s) => {
          if (!keys.some((key) => key in s.drafts)) return s
          const drafts = { ...s.drafts }
          for (const key of keys) delete drafts[key]
          return { drafts }
        }),
    }),
    {
      name: STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(debouncedStorage),
      partialize: ({ drafts, lastNewSession }) => ({ drafts, lastNewSession }),
    },
  ),
)
