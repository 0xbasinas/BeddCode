import { create } from 'zustand'

export const composerDraftKey = (hostKey: string, draftId: string) =>
  JSON.stringify([hostKey, draftId])

interface NewSessionDestination {
  hostKey: string
  folder: string
}

/** Text stays with its chat or new-session folder while navigating around this window. */
export const useComposerDrafts = create<{
  drafts: Record<string, string>
  lastNewSession?: NewSessionDestination
  rememberNewSession(destination: NewSessionDestination): void
  setDraft(key: string, text: string): void
  restoreDraft(key: string, text: string): void
}>((set) => ({
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
}))
