import { create } from 'zustand'

export const threadKey = (hostKey: string, sessionId: string) =>
  JSON.stringify([hostKey, sessionId])

/** Composer text stays with its chat while navigating around this window. */
export const useThreadDrafts = create<{
  drafts: Record<string, string>
  setDraft(key: string, text: string): void
  restoreDraft(key: string, text: string): void
}>((set) => ({
  drafts: {},
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

interface ReadingPosition {
  top: number
  following: boolean
  /** Earlier blocks opened by Show earlier or the message navigator. */
  from?: number
}

// Scroll events do not need to notify React or write to disk.
const readingPositions = new Map<string, ReadingPosition>()

export const readingPosition = (key: string | undefined) =>
  key ? readingPositions.get(key) : undefined

export function rememberReadingPosition(key: string, patch: Partial<ReadingPosition>) {
  readingPositions.set(key, { top: 0, following: true, ...readingPositions.get(key), ...patch })
}
