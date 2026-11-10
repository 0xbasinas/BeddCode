import { create } from 'zustand'

/** A message to place in the composer, e.g. a quote, a CI follow-up, or a failed command. */
export const useComposerPrefill = create<{
  pending?: { sessionId: string; text: string }
  set(sessionId: string, text: string): void
  take(sessionId: string): string | undefined
}>((set, get) => ({
  set: (sessionId, text) => set({ pending: { sessionId, text } }),
  take: (sessionId) => {
    const pending = get().pending
    if (!pending || pending.sessionId !== sessionId) return undefined
    set({ pending: undefined })
    return pending.text
  },
}))
