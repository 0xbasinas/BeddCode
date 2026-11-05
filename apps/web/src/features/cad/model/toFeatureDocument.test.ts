import { describe, expect, it } from 'vitest'
import { planRebuild } from '../kernel/featureOps.ts'
import {
  addHole,
  appendFeature,
  appendSketch,
  emptyDocument,
  makeBoxFeature,
  makeCylinderFeature,
  makeExtrudeFeature,
  makeFilletFeature,
  makeHoleFeature,
  makeSphereFeature,
  updateFeature,
} from './CadDocument.ts'
import { toFeatureDocument, visibleShapeIds } from './toFeatureDocument.ts'

function bracket() {
  let doc = emptyDocument({ id: 'part', name: 'Part' })
  doc = appendFeature(doc, {
    ...makeBoxFeature(doc, 'base'),
    params: { width: 30, depth: 20, height: 10, x: 4, y: 5, z: 1 },
  })
  const sketched = appendSketch(doc, 'XY', 'profile')
  doc = sketched.doc
  doc = {
    ...doc,
    sketches: doc.sketches.map((sketch) =>
      sketch.id === 'profile'
        ? {
            ...sketch,
            entities: [{ id: 'r', kind: 'rect' as const, x: 0, y: 0, width: 10, height: 4 }],
          }
        : sketch,
    ),
  }
  doc = appendFeature(doc, makeExtrudeFeature(doc, 'profile', 'pad'))
  doc = updateFeature(doc, 'pad', { params: { distance: 8 } })
  doc = appendFeature(doc, makeFilletFeature(doc, 'pad', '3,4', 'edge'))
  return doc
}

describe('toFeatureDocument', () => {
  it('plans a box, an extrude, and a fillet', () => {
    const plan = toFeatureDocument(bracket())
    expect(plan.errors).toEqual({})
    expect(plan.document.ops.map((op) => op.op)).toEqual(['primitive', 'extrude', 'fillet'])
    expect(plan.document.ops[0]).toEqual({
      op: 'primitive',
      id: 'base',
      kind: 'box',
      params: { width: 30, depth: 20, height: 10 },
    })
    expect(plan.document.ops[1]).toEqual({
      op: 'extrude',
      id: 'pad',
      distance: 8,
      profile: {
        plane: 'XY',
        points: [
          [0, 0],
          [10, 0],
          [10, 4],
          [0, 4],
        ],
      },
    })
    const fillet = plan.document.ops[2] as { edgeIds?: number[]; target?: string; radius?: number }
    expect(fillet).toMatchObject({ op: 'fillet', id: 'edge', target: 'pad', radius: 1 })
    expect(fillet.edgeIds).toEqual([3, 4])
    expect(planRebuild(plan.document).map((op) => op.id)).toEqual(['base', 'pad', 'edge'])
    expect(visibleShapeIds(plan.document.ops)).toEqual(['base', 'edge'])
  })

  it('expands bothSides into two extrudes and a fuse', () => {
    let doc = appendSketch(emptyDocument(), 'XY', 'profile').doc
    doc = {
      ...doc,
      sketches: doc.sketches.map((sketch) => ({
        ...sketch,
        entities: [{ id: 'r', kind: 'rect' as const, x: 0, y: 0, width: 4, height: 4 }],
      })),
    }
    doc = appendFeature(doc, makeExtrudeFeature(doc, 'profile', 'pad'))
    doc = updateFeature(doc, 'pad', { params: { bothSides: true, distance: 8 } })
    const plan = toFeatureDocument(doc)
    expect(plan.errors).toEqual({})
    expect(plan.document.ops.map((op) => op.id)).toEqual(['pad::pos', 'pad::neg', 'pad'])
    expect(plan.document.ops[0]).toMatchObject({ op: 'extrude', distance: 8 })
    expect(plan.document.ops[1]).toMatchObject({ op: 'extrude', distance: -8 })
    expect(plan.document.ops[2]).toMatchObject({
      op: 'boolean',
      mode: 'fuse',
      target: 'pad::pos',
      tool: 'pad::neg',
    })
    expect(planRebuild(plan.document).map((op) => op.id)).toEqual(['pad::pos', 'pad::neg', 'pad'])
    expect(visibleShapeIds(plan.document.ops)).toEqual(['pad'])
  })

  it('keeps earlier feature ids when a later feature fails', () => {
    let doc = appendFeature(emptyDocument(), makeBoxFeature(emptyDocument(), 'base'))
    doc = appendFeature(doc, makeExtrudeFeature(doc, 'missing', 'pad'))
    doc = appendFeature(doc, makeCylinderFeature(doc, 'pin'))
    const plan = toFeatureDocument(doc)
    expect(plan.document.ops.map((op) => op.id)).toEqual(['base', 'pin'])
    expect(plan.errors.pad).toMatch(/sketch/)
    expect(plan.errors.base).toBeUndefined()
  })

  it('skips suppressed features and features past historyIndex', () => {
    let doc = bracket()
    doc = updateFeature(doc, 'edge', { suppressed: true })
    const suppressed = toFeatureDocument(doc)
    expect(suppressed.document.ops.map((op) => op.id)).toEqual(['base', 'pad'])
    const rolled = toFeatureDocument({ ...bracket(), historyIndex: 0 })
    expect(rolled.document.ops.map((op) => op.id)).toEqual(['base'])
  })

  it('maps cylinder and sphere primitives', () => {
    let doc = appendFeature(emptyDocument(), makeCylinderFeature(emptyDocument(), 'pin'))
    doc = appendFeature(doc, makeSphereFeature(doc, 'ball'))
    const plan = toFeatureDocument(doc)
    expect(plan.document.ops).toEqual([
      { op: 'primitive', id: 'pin', kind: 'cylinder', params: { radius: 10, height: 20 } },
      { op: 'primitive', id: 'ball', kind: 'sphere', params: { radius: 10 } },
    ])
  })

  it('cuts an extrude from the previous body and imports STEP bytes', () => {
    let doc = appendFeature(emptyDocument(), makeBoxFeature(emptyDocument(), 'base'))
    const sketched = appendSketch(doc, 'XY', 'profile')
    doc = {
      ...sketched.doc,
      sketches: sketched.doc.sketches.map((sketch) => ({
        ...sketch,
        entities: [{ id: 'r', kind: 'rect' as const, x: 0, y: 0, width: 2, height: 2 }],
      })),
    }
    doc = appendFeature(doc, makeExtrudeFeature(doc, 'profile', 'pad'))
    doc = updateFeature(doc, 'pad', { params: { cut: true } })
    const bytes = new Uint8Array([1, 2, 3])
    doc = appendFeature(doc, {
      id: 'step',
      name: 'bracket.step',
      kind: 'import',
      suppressed: false,
      params: { fileName: 'bracket.step' },
    })
    const plan = toFeatureDocument(doc, { step: bytes })
    expect(plan.errors).toEqual({})
    expect(plan.document.ops.map((op) => op.id)).toEqual(['base', 'pad::tool', 'pad', 'step'])
    expect(plan.document.ops[2]).toMatchObject({
      op: 'boolean',
      mode: 'cut',
      target: 'base',
      tool: 'pad::tool',
    })
    expect(plan.files.step).toBe(bytes)
    const missing = toFeatureDocument(doc)
    expect(missing.errors.step).toMatch(/STEP/)
    expect(missing.document.ops.map((op) => op.id)).toEqual(['base', 'pad::tool', 'pad'])
  })

  it('cuts a through hole from the target and keeps fillet edge refs', () => {
    let doc = appendFeature(emptyDocument(), makeBoxFeature(emptyDocument(), 'base'))
    doc = addHole(
      doc,
      { target: 'base', diameter: 8, x: 1, y: 2, z: 10, throughAll: true },
      'hole',
    ).doc
    const refs = JSON.stringify([{ kind: 'edge', mid: [1, 0, 0], dir: [1, 0, 0], length: 10 }])
    doc = appendFeature(doc, makeFilletFeature(doc, 'hole', '7', 'round', refs))
    const plan = toFeatureDocument(doc)
    expect(plan.errors).toEqual({})
    expect(plan.document.ops.map((op) => op.id)).toEqual(['base', 'hole::tool', 'hole', 'round'])
    expect(plan.document.ops[1]).toMatchObject({
      op: 'extrude',
      distance: 1000,
      bothSides: true,
      profile: { plane: 'XY' },
    })
    const profile = (plan.document.ops[1] as { profile: { points: number[][] } }).profile
    expect(profile.points).toHaveLength(16)
    expect(profile.points[0]).toEqual([5, 2])
    expect(plan.document.ops[2]).toMatchObject({
      op: 'boolean',
      mode: 'cut',
      target: 'base',
      tool: 'hole::tool',
    })
    const fillet = plan.document.ops[3] as { edgeIds?: number[]; edgeRefs?: unknown }
    expect(fillet.edgeIds).toEqual([7])
    expect(fillet.edgeRefs).toEqual([{ kind: 'edge', mid: [1, 0, 0], dir: [1, 0, 0], length: 10 }])
    expect(planRebuild(plan.document).map((op) => op.id)).toEqual([
      'base',
      'hole::tool',
      'hole',
      'round',
    ])
    expect(visibleShapeIds(plan.document.ops)).toEqual(['round'])
  })

  it('maps a blind hole and a counterbore, and reports a missing target', () => {
    let doc = appendFeature(emptyDocument(), makeBoxFeature(emptyDocument(), 'base'))
    doc = addHole(doc, { target: 'base', diameter: 6, depth: 4, throughAll: false }, 'blind').doc
    doc = addHole(
      doc,
      { target: 'blind', diameter: 4, cboreDiameter: 12, cboreDepth: 3, throughAll: true },
      'cbore',
    ).doc
    const plan = toFeatureDocument(doc)
    expect(plan.errors).toEqual({})
    expect(plan.document.ops.map((op) => op.id)).toEqual([
      'base',
      'blind::tool',
      'blind',
      'cbore::cbore',
      'cbore::cbore-cut',
      'cbore::tool',
      'cbore',
    ])
    expect(plan.document.ops[1]).toMatchObject({ op: 'extrude', distance: 4 })
    expect(plan.document.ops[1]).not.toHaveProperty('bothSides')
    expect(plan.document.ops[3]).toMatchObject({ op: 'extrude', distance: 3 })
    expect(visibleShapeIds(plan.document.ops)).toEqual(['cbore'])

    const missing = appendFeature(
      emptyDocument(),
      makeHoleFeature(emptyDocument(), { target: 'gone', diameter: 8 }, 'h'),
    )
    const failed = toFeatureDocument(missing)
    expect(failed.errors.h).toMatch(/unknown shape gone/)
    expect(failed.document.ops).toEqual([])
  })
})
