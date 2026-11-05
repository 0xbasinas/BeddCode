import { describe, expect, it } from 'vitest'
import { emptyCadDocument } from './CadDocument.ts'
import {
  addFeature,
  deleteFeature,
  editFeatureParams,
  reorderFeature,
  suppressFeature,
} from './featureTree.ts'
import { current, createHistory, redo, undo, update } from './undo.ts'

describe('feature tree', () => {
  it('reorders, suppresses, and deletes features', () => {
    let doc = emptyCadDocument()
    doc = addFeature(doc, { id: 'box', kind: 'box', params: { width: 10, depth: 20, height: 30 } })
    doc = addFeature(doc, {
      id: 'tool',
      kind: 'cylinder',
      params: { radius: 2, height: 40 },
    })
    doc = addFeature(doc, { id: 'cut', kind: 'cut', params: { targetId: 'box', toolId: 'tool' } })

    doc = reorderFeature(doc, 'cut', 0)
    expect(doc.features.map((feature) => feature.id)).toEqual(['cut', 'box', 'tool'])

    doc = reorderFeature(doc, 'cut', 2)
    expect(doc.features.map((feature) => feature.id)).toEqual(['box', 'tool', 'cut'])

    doc = suppressFeature(doc, 'tool')
    expect(doc.features.find((feature) => feature.id === 'tool')?.suppressed).toBe(true)
    doc = suppressFeature(doc, 'tool', false)
    expect(doc.features.find((feature) => feature.id === 'tool')?.suppressed).toBe(false)

    doc = editFeatureParams(doc, 'box', { width: 12 })
    expect(doc.features.find((feature) => feature.id === 'box')?.params).toEqual({
      width: 12,
      depth: 20,
      height: 30,
    })

    doc = deleteFeature(doc, 'tool')
    expect(doc.features.map((feature) => feature.id)).toEqual(['box', 'cut'])
  })

  it('rejects a missing feature and an index outside the tree', () => {
    const doc = emptyCadDocument()
    expect(() => deleteFeature(doc, 'missing')).toThrow(/No feature missing/)
    expect(() => suppressFeature(doc, 'missing')).toThrow(/No feature missing/)
    const withBox = addFeature(doc, {
      id: 'box',
      kind: 'box',
      params: { width: 1, depth: 1, height: 1 },
    })
    expect(() => reorderFeature(withBox, 'box', 3)).toThrow(/outside/)
  })

  it('undo and redo restore the tree around each edit', () => {
    let history = createHistory(emptyCadDocument())
    history = update(history, (doc) =>
      addFeature(doc, { id: 'box', kind: 'box', params: { width: 10, depth: 10, height: 10 } }),
    )
    history = update(history, (doc) =>
      addFeature(doc, { id: 'cut', kind: 'cut', params: { targetId: 'box', toolId: 'box' } }),
    )
    expect(current(history).features.map((feature) => feature.id)).toEqual(['box', 'cut'])

    history = undo(history)
    expect(current(history).features.map((feature) => feature.id)).toEqual(['box'])
    expect(current(history).historyIndex).toBe(1)

    history = undo(history)
    expect(current(history).features).toEqual([])

    history = undo(history)
    expect(current(history).features).toEqual([])

    history = redo(history)
    history = redo(history)
    expect(current(history).features.map((feature) => feature.id)).toEqual(['box', 'cut'])

    history = undo(history)
    history = update(history, (doc) => deleteFeature(doc, 'box'))
    expect(current(history).features).toEqual([])
    history = redo(history)
    expect(current(history).features).toEqual([])
  })
})
