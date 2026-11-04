import { create } from 'zustand'
import type { PickedElement } from '@beddcode/client-runtime'

export interface BrowserAnnotation {
  id: string
  host: string
  session: string
  tab: number
  element: PickedElement
  comment: string
  stale: boolean
}

export const annotationKey = (host: string, session: string) => JSON.stringify([host, session])
export const EMPTY_ANNOTATIONS: BrowserAnnotation[] = []

export const useAnnotations = create<{
  drafts: Record<string, BrowserAnnotation[]>
  add(item: BrowserAnnotation): void
  edit(key: string, id: string, comment: string): void
  remove(key: string, ids: string[]): void
  invalidateTab(tab: number): void
  invalidateDraft(key: string): void
}>((set) => ({
  drafts: {},
  add: (item) =>
    set((s) => {
      const key = annotationKey(item.host, item.session)
      return { drafts: { ...s.drafts, [key]: [...(s.drafts[key] ?? []), item] } }
    }),
  edit: (key, id, comment) =>
    set((s) => ({
      drafts: {
        ...s.drafts,
        [key]: (s.drafts[key] ?? []).map((a) => (a.id === id ? { ...a, comment } : a)),
      },
    })),
  remove: (key, ids) =>
    set((s) => ({
      drafts: { ...s.drafts, [key]: (s.drafts[key] ?? []).filter((a) => !ids.includes(a.id)) },
    })),
  invalidateDraft: (key) =>
    set((s) => ({
      drafts: { ...s.drafts, [key]: (s.drafts[key] ?? []).map((a) => ({ ...a, stale: true })) },
    })),
  invalidateTab: (tab) =>
    set((s) => ({
      drafts: Object.fromEntries(
        Object.entries(s.drafts).map(([key, items]) => [
          key,
          items.map((a) => (a.tab === tab ? { ...a, stale: true } : a)),
        ]),
      ),
    })),
}))
