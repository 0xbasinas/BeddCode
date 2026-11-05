import { describe, expect, it } from 'vitest'
import { emptyCadDocument, type CadDocument } from './CadDocument.ts'
import { addFeature, suppressFeature } from './featureTree.ts'
import {
  applyRebuild,
  rebuild,
  rebuildPlan,
  type RebuildKernel,
  type RebuildOp,
} from './rebuild.ts'

function part(): CadDocument {
  let doc = emptyCadDocument({ id: 'bracket', name: 'Bracket' })
  doc = addFeature(doc, { id: 'box', kind: 'box', params: { width: 40, depth: 20, height: 10 } })
  doc = addFeature(doc, {
    id: 'hole',
    kind: 'cylinder',
    params: { radius: 3, height: 10 },
  })
  doc = addFeature(doc, { id: 'cut', kind: 'cut', params: { targetId: 'box', toolId: 'hole' } })
  return doc
}

function recordingKernel(): { kernel: RebuildKernel; calls: RebuildOp[] } {
  const calls: RebuildOp[] = []
  const record = (op: RebuildOp) => {
    calls.push(op)
  }
  const kernel: RebuildKernel = {
    box: record,
    cylinder: record,
    sphere: record,
    extrude: record,
    revolve: record,
    fillet: record,
    chamfer: record,
    union: record,
    cut: record,
    intersect: record,
  }
  return { kernel, calls }
}

describe('rebuild', () => {
  it('applies a box and then a cut through a mock kernel', () => {
    let doc = emptyCadDocument()
    doc = addFeature(doc, { id: 'box', kind: 'box', params: { width: 8, depth: 8, height: 8 } })
    doc = addFeature(doc, { id: 'cut', kind: 'cut', params: { targetId: 'box', toolId: 'box' } })

    const plan = rebuildPlan(doc)
    expect(plan.map((op) => op.kind)).toEqual(['box', 'cut'])
    expect(plan[0]).toMatchObject({
      featureId: 'box',
      kind: 'box',
      params: { width: 8, depth: 8, height: 8 },
    })
    expect(plan[1]).toMatchObject({
      featureId: 'cut',
      kind: 'cut',
      params: { targetId: 'box', toolId: 'box' },
    })

    const { kernel, calls } = recordingKernel()
    applyRebuild(plan, kernel)
    expect(calls.map((op) => op.kind)).toEqual(['box', 'cut'])
  })

  it('skips a suppressed feature and still cuts the box', () => {
    const doc = suppressFeature(part(), 'hole')
    const { kernel, calls } = recordingKernel()
    rebuild(doc, kernel)
    expect(calls.map((op) => op.kind)).toEqual(['box', 'cut'])
    expect(calls.map((op) => op.featureId)).toEqual(['box', 'cut'])
  })

  it('keeps extrude params including the sketch id', () => {
    let doc = emptyCadDocument()
    doc = addFeature(doc, {
      id: 'pad',
      kind: 'extrude',
      params: { sketchId: 'profile', distance: 5 },
    })
    const [op] = rebuildPlan(doc)
    expect(op?.kind).toBe('extrude')
    expect(op?.params).toMatchObject({ sketchId: 'profile', distance: 5 })
  })
})
