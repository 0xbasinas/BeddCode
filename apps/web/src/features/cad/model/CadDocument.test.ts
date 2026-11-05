import { describe, expect, it } from 'vitest'
import {
  addHole,
  appendFeature,
  emptyDocument,
  isCadDocument,
  makeBoxFeature,
  makeCylinderFeature,
  makeSphereFeature,
  moveFeature,
  removeFeature,
  updateFeature,
} from './CadDocument.ts'
import { UndoStack } from './undo.ts'

describe('CadDocument', () => {
  it('appends a box and bumps rev and history', () => {
    const start = emptyDocument()
    const feature = makeBoxFeature(start, 'b1')
    const next = appendFeature(start, feature)
    expect(next.features).toHaveLength(1)
    expect(next.features[0]?.name).toBe('Box 1')
    expect(next.rev).toBe(1)
    expect(next.historyIndex).toBe(0)
    expect(next.features[0]?.params).toMatchObject({ width: 20, height: 20, y: 10 })
  })

  it('offsets a second box', () => {
    const once = appendFeature(emptyDocument(), makeBoxFeature(emptyDocument(), 'a'))
    const second = makeBoxFeature(once, 'b')
    expect(second.params.x).toBe(30)
    expect(second.name).toBe('Box 2')
  })

  it('builds a cylinder and a sphere with editable sizes', () => {
    const doc = emptyDocument()
    const cylinder = makeCylinderFeature(doc, 'c1')
    expect(cylinder.kind).toBe('cylinder')
    expect(cylinder.name).toBe('Cylinder 1')
    expect(cylinder.params).toMatchObject({ radius: 10, height: 20, y: 10 })
    const withCylinder = appendFeature(doc, cylinder)
    const second = makeCylinderFeature(withCylinder, 'c2')
    expect(second.name).toBe('Cylinder 2')
    expect(second.params.x).toBe(30)
    const sphere = makeSphereFeature(doc, 's1')
    expect(sphere.kind).toBe('sphere')
    expect(sphere.name).toBe('Sphere 1')
    expect(sphere.params).toMatchObject({ radius: 10, y: 10 })
    const secondSphere = makeSphereFeature(appendFeature(doc, sphere), 's2')
    expect(secondSphere.name).toBe('Sphere 2')
    expect(secondSphere.params.x).toBe(30)
  })

  it('edits, moves, and removes features', () => {
    let doc = appendFeature(emptyDocument(), makeBoxFeature(emptyDocument(), 'a'))
    doc = appendFeature(doc, makeBoxFeature(doc, 'b'))
    doc = updateFeature(doc, 'a', { params: { width: 40 }, suppressed: true })
    expect(doc.features[0]?.params.width).toBe(40)
    expect(doc.features[0]?.params.height).toBe(20)
    expect(doc.features[0]?.suppressed).toBe(true)
    doc = moveFeature(doc, 'b', -1)
    expect(doc.features.map((feature) => feature.id)).toEqual(['b', 'a'])
    expect(moveFeature(doc, 'b', -1)).toBe(doc)
    doc = removeFeature(doc, 'a')
    expect(doc.features.map((feature) => feature.id)).toEqual(['b'])
    expect(doc.historyIndex).toBe(0)
    expect(removeFeature(doc, 'missing')).toBe(doc)
  })

  it('adds a hole on a face point', () => {
    const start = appendFeature(emptyDocument(), makeBoxFeature(emptyDocument(), 'base'))
    const next = addHole(start, {
      id: 'h1',
      target: 'base',
      diameter: 6,
      depth: 4,
      x: 1,
      y: 2,
      z: 3,
    })
    expect(next.features[1]).toMatchObject({
      id: 'h1',
      kind: 'hole',
      name: 'Hole 1',
      params: { target: 'base', diameter: 6, depth: 4, x: 1, y: 2, z: 3 },
    })
    expect(next.historyIndex).toBe(1)
    expect(next.rev).toBe(start.rev + 1)
    const second = addHole(next, {
      id: 'h2',
      target: 'base',
      diameter: 2,
      throughAll: true,
      facePoint: [0, 0, 20],
      cboreDiameter: 5,
      cboreDepth: 1,
    })
    expect(second.features[2]?.name).toBe('Hole 2')
    expect(second.features[2]?.params).toMatchObject({
      throughAll: true,
      x: 0,
      y: 0,
      z: 20,
      diameter: 2,
      cboreDiameter: 5,
      cboreDepth: 1,
    })
  })

  it('recognizes a document and rejects other json', () => {
    const doc = appendFeature(emptyDocument(), makeBoxFeature(emptyDocument(), 'a'))
    expect(isCadDocument(JSON.parse(JSON.stringify(doc)))).toBe(true)
    expect(isCadDocument({ rev: 1 })).toBe(false)
    expect(isCadDocument(null)).toBe(false)
  })
})

describe('undo stack', () => {
  it('undoes and redoes document snapshots', () => {
    const stack = new UndoStack(emptyDocument())
    const withBox = appendFeature(stack.current(), makeBoxFeature(stack.current(), 'a'))
    stack.push(withBox)
    expect(stack.canUndo()).toBe(true)
    expect(stack.undo().features).toHaveLength(0)
    expect(stack.canRedo()).toBe(true)
    expect(stack.redo().features).toHaveLength(1)
    stack.undo()
    stack.push(appendFeature(stack.current(), makeBoxFeature(stack.current(), 'b')))
    expect(stack.canRedo()).toBe(false)
    expect(stack.undo()).toBe(stack.current())
  })
})
