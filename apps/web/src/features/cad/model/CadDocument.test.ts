import { describe, expect, it } from 'vitest'
import {
  addHole,
  addHoleFromFace,
  appendFeature,
  emptyDocument,
  isCadDocument,
  makeBoxFeature,
  makeCylinderFeature,
  makeFilletFeature,
  makeSphereFeature,
  moveFeature,
  openFaceSketch,
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

  it('reopens a face sketch and keeps a free datum sketch separate', () => {
    const face = openFaceSketch(
      emptyDocument(),
      {
        plane: 'XY',
        origin: [0, 0, 20],
        normal: [0, 0, 1],
        hostId: 'box',
        faceId: 3,
      },
      'sk1',
    )
    expect(face.created).toBe(true)
    expect(face.sketch).toMatchObject({
      plane: 'XY',
      origin: [0, 0, 20],
      normal: [0, 0, 1],
      hostId: 'box',
      faceId: 3,
    })
    expect(face.feature.params).toMatchObject({
      plane: 'XY',
      originX: 0,
      originY: 0,
      originZ: 20,
      normalZ: 1,
    })
    const again = openFaceSketch(face.doc, {
      plane: 'XY',
      origin: [0, 0, 20],
      normal: [0, 0, 1],
      hostId: 'box',
      faceId: 3,
    })
    expect(again.created).toBe(false)
    expect(again.doc).toBe(face.doc)
    expect(again.feature.id).toBe('sk1')

    const named = openFaceSketch(emptyDocument(), { plane: 'YZ', hostId: 'box', faceId: 1 }, 'sk2')
    expect(named.sketch.origin).toBeUndefined()
    expect(named.feature.params).toEqual({ plane: 'YZ' })

    const free = openFaceSketch(face.doc, { plane: 'XY' }, 'sk3')
    expect(free.created).toBe(true)
    expect(free.doc.sketches).toHaveLength(2)
    const reopened = openFaceSketch(free.doc, { plane: 'XY' })
    expect(reopened.created).toBe(false)
    expect(reopened.feature.id).toBe('sk3')
  })

  it('adds a hole with defaults and accepts a face point', () => {
    const placed = addHole(emptyDocument(), { target: 'base', x: 1.234, y: -2, z: 10 }, 'h1')
    expect(placed.feature.kind).toBe('hole')
    expect(placed.feature.name).toBe('Hole 1')
    expect(placed.feature.params).toMatchObject({
      target: 'base',
      diameter: 8,
      throughAll: true,
      x: 1.234,
      y: -2,
      z: 10,
    })
    expect(placed.feature.params).not.toHaveProperty('cboreDiameter')
    expect(placed.feature.params).not.toHaveProperty('depth')
    expect(placed.doc.features).toEqual([placed.feature])
    expect(placed.doc.rev).toBe(1)

    const start = appendFeature(emptyDocument(), makeBoxFeature(emptyDocument(), 'base'))
    const next = addHole(start, {
      id: 'h1',
      target: 'base',
      diameter: 6,
      depth: 4,
      x: 1,
      y: 2,
      z: 3,
      throughAll: false,
    })
    expect(next.feature.params).toMatchObject({
      target: 'base',
      diameter: 6,
      depth: 4,
      x: 1,
      y: 2,
      z: 3,
      throughAll: false,
    })
    expect(next.feature.params).not.toHaveProperty('cboreDiameter')
    expect(next.doc.historyIndex).toBe(1)
    expect(next.doc.rev).toBe(start.rev + 1)

    const second = addHole(next.doc, {
      id: 'h2',
      target: 'base',
      diameter: 2,
      throughAll: true,
      facePoint: [0, 0, 20],
      cboreDiameter: 5,
      cboreDepth: 1,
    })
    expect(second.feature.name).toBe('Hole 2')
    expect(second.feature.params).toMatchObject({
      throughAll: true,
      x: 0,
      y: 0,
      z: 20,
      diameter: 2,
      cboreDiameter: 5,
      cboreDepth: 1,
    })

    const fillet = makeFilletFeature(placed.doc, 'base', '3,4', 'f', '[{"kind":"edge"}]')
    expect(fillet.params).toMatchObject({
      targetId: 'base',
      radius: 4,
      edgeIds: '3,4',
      edgeRefs: '[{"kind":"edge"}]',
    })
  })

  it('places a hole from the clicked plate face', () => {
    let doc = appendFeature(emptyDocument(), {
      ...makeBoxFeature(emptyDocument(), 'plate'),
      name: 'Plate',
      params: { width: 40, depth: 30, height: 8, x: 0, y: 4, z: 0 },
    })
    doc = appendFeature(doc, {
      ...makeBoxFeature(doc, 'boss'),
      name: 'Boss',
      params: { width: 10, depth: 10, height: 12, x: 0, y: 6, z: 0 },
    })
    const placed = addHoleFromFace(doc, {
      id: 'drill',
      targetId: 'plate',
      point: [12.2, -4, 8.4],
      normal: [0, 0, 1],
      planeOrigin: [0, 0, 8],
    })
    expect(placed.feature.params).toMatchObject({
      target: 'plate',
      targetId: 'plate',
      x: 12.2,
      y: -4,
      z: 8,
      diameter: 8,
      throughAll: true,
      direction: '-Z',
    })
    expect(placed.feature.params).not.toHaveProperty('depth')
    expect(placed.doc.features.map((feature) => feature.id)).toEqual(['plate', 'boss', 'drill'])

    const onBoss = addHoleFromFace(doc, {
      id: 'boss-hole',
      targetId: 'boss',
      point: [0, 0, 12.2],
      normal: [0, 0, 1],
      planeOrigin: [0, 0, 12],
    })
    expect(onBoss.feature.params.targetId).toBe('boss')
    expect(onBoss.feature.params).toMatchObject({ x: 0, y: 0, z: 12, direction: '-Z' })

    expect(() =>
      addHoleFromFace(doc, {
        targetId: 'missing',
        point: [1, 2, 3],
        normal: [0, 0, 1],
      }),
    ).toThrow(/owns the face/)
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
