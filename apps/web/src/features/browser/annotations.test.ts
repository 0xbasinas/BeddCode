import { beforeEach, describe, expect, it } from 'vitest'
import { annotationKey, useAnnotations, type BrowserAnnotation } from './annotations.ts'

const item = (id: string, tab = 1): BrowserAnnotation => ({
  id,
  tab,
  host: 'host',
  session: 'session',
  comment: `comment ${id}`,
  stale: false,
  element: {
    documentId: 'document',
    url: 'https://example.com',
    title: 'Page',
    selector: `#${id}`,
    html: '<div/>',
    truncated: false,
    rect: { x: 0, y: 0, width: 1, height: 1 },
  },
})

describe('browser annotation drafts', () => {
  beforeEach(() => useAnnotations.setState({ drafts: {} }))
  it('keeps edited comments when another annotation is removed', () => {
    const key = annotationKey('host', 'session')
    const store = useAnnotations.getState()
    store.add(item('one'))
    store.add(item('two'))
    store.edit(key, 'two', 'Updated comment')
    store.remove(key, ['one'])
    expect(useAnnotations.getState().drafts[key]).toEqual([
      expect.objectContaining({ id: 'two', comment: 'Updated comment' }),
    ])
  })
  it('marks captures from a navigated or closed tab stale without affecting other tabs', () => {
    const key = annotationKey('host', 'session')
    useAnnotations.getState().add(item('one'))
    useAnnotations.getState().add(item('two', 2))
    useAnnotations.getState().invalidateTab(1)
    expect(useAnnotations.getState().drafts[key]!.map((a) => a.stale)).toEqual([true, false])
    expect(useAnnotations.getState().drafts[annotationKey('other', 'session')]).toBeUndefined()
  })
})
