import type { ReviewComment } from '@beddcode/client-runtime'
import { create } from 'zustand'

/** Pending review comments for a session's Git pane, keyed by host and folder. */
export const useReviewStore = create<{
  comments: Record<string, ReviewComment[]>
  add(key: string, comment: ReviewComment): void
  clearSent(key: string, sent: readonly ReviewComment[]): void
}>((set) => ({
  comments: {},
  add: (key, comment) =>
    set((s) => ({ comments: { ...s.comments, [key]: [...(s.comments[key] ?? []), comment] } })),
  clearSent: (key, sent) => {
    const ids = new Set(sent.map((c) => c.id))
    set((s) => ({
      comments: { ...s.comments, [key]: (s.comments[key] ?? []).filter((c) => !ids.has(c.id)) },
    }))
  },
}))

export const reviewKey = (hostKey: string, cwd: string) => `${hostKey}:${cwd}`
