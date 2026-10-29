import { create } from 'zustand'
import { withoutSent, type ReviewComment } from '@beddcode/client-runtime'

const STORAGE_KEY = 'beddcode.review-comments'

/** Review comments are per host and folder: the same repository on two machines is two reviews. */
export const reviewKey = (hostKey: string, cwd: string) => JSON.stringify([hostKey, cwd])

interface ReviewState {
  comments: Record<string, ReviewComment[]>
  add(key: string, comment: ReviewComment): void
  edit(key: string, id: string, body: string): void
  remove(key: string, id: string): void
  /** Drops the comments that were sent; ones added meanwhile stay. */
  clearSent(key: string, sent: readonly ReviewComment[]): void
}

function load(): Record<string, ReviewComment[]> {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as unknown) : {}
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ReviewComment[]>) : {}
  } catch {
    return {}
  }
}

function save(comments: Record<string, ReviewComment[]>) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(comments))
  } catch {
    // Full or blocked storage: the comments still work for this run.
  }
}

const put = (all: Record<string, ReviewComment[]>, key: string, list: ReviewComment[]) => {
  const next = { ...all }
  if (list.length) next[key] = list
  else delete next[key]
  save(next)
  return { comments: next }
}

export const useReviewStore = create<ReviewState>((set) => ({
  comments: load(),
  add: (key, comment) => set((s) => put(s.comments, key, [...(s.comments[key] ?? []), comment])),
  edit: (key, id, body) =>
    set((s) =>
      put(
        s.comments,
        key,
        (s.comments[key] ?? []).map((c) => (c.id === id ? { ...c, body } : c)),
      ),
    ),
  remove: (key, id) =>
    set((s) =>
      put(
        s.comments,
        key,
        (s.comments[key] ?? []).filter((c) => c.id !== id),
      ),
    ),
  clearSent: (key, sent) =>
    set((s) => put(s.comments, key, withoutSent(s.comments[key] ?? [], sent))),
}))

const NONE: ReviewComment[] = []
export const useReviewComments = (key: string) => useReviewStore((s) => s.comments[key] ?? NONE)
