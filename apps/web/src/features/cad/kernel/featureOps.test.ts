import { describe, expect, it } from 'vitest'
import { parseFeatureDocument, planRebuild, serializeFeatureDocument } from './featureOps.ts'

const box = {
  op: 'primitive' as const,
  id: 'base',
  kind: 'box' as const,
  params: { width: 30, depth: 20, height: 10 },
}

describe('feature document rebuild plan', () => {
  it('serializes ops in replay order with stable keys', () => {
    const doc = {
      version: 1 as const,
      ops: [box, { op: 'fillet' as const, id: 'edge', target: 'base', radius: 1 }],
    }
    const text = serializeFeatureDocument(doc)
    expect(text).toBe(
      '{"ops":[{"id":"base","kind":"box","op":"primitive","params":{"depth":20,"height":10,"width":30}},{"id":"edge","op":"fillet","radius":1,"target":"base"}],"version":1}',
    )
    expect(serializeFeatureDocument(parseFeatureDocument(text))).toBe(text)
    expect(planRebuild(parseFeatureDocument(text)).map((op) => op.id)).toEqual(['base', 'edge'])
  })

  it('plans extrude, revolve, chamfer, and boolean after the solids they use', () => {
    const ops = planRebuild({
      version: 1,
      ops: [
        box,
        {
          op: 'extrude',
          id: 'wall',
          distance: 8,
          profile: {
            plane: 'XY',
            points: [
              [0, 0],
              [10, 0],
              [10, 4],
            ],
          },
        },
        {
          op: 'revolve',
          id: 'knob',
          angle: 360,
          axis: 'Y',
          profile: {
            points: [
              [2, 0],
              [4, 0],
              [3, 5],
            ],
          },
        },
        { op: 'chamfer', id: 'lip', target: 'wall', radius: 0.4 },
        { op: 'boolean', id: 'part', mode: 'cut', target: 'base', tool: 'knob' },
        { op: 'importStep', id: 'step', name: 'bracket.step' },
      ],
    })
    expect(ops.map((op) => op.op)).toEqual([
      'primitive',
      'extrude',
      'revolve',
      'chamfer',
      'boolean',
      'importStep',
    ])
  })

  it('rejects a document that cannot be rebuilt', () => {
    expect(() => planRebuild({ version: 2, ops: [] })).toThrow(/version/)
    expect(() => planRebuild({ version: 1, ops: [box, box] })).toThrow(/duplicate feature id base/)
    expect(() =>
      planRebuild({ version: 1, ops: [{ op: 'fillet', id: 'f', target: 'missing', radius: 1 }] }),
    ).toThrow(/unknown shape missing/)
    expect(() =>
      planRebuild({
        version: 1,
        ops: [
          box,
          { op: 'primitive', id: 'tool', kind: 'sphere', params: { radius: 2 } },
          { op: 'boolean', id: 'both', mode: 'fuse', target: 'base', tool: 'base' },
        ],
      }),
    ).toThrow(/must differ/)
    expect(() =>
      planRebuild({ version: 1, ops: [{ ...box, params: { width: 0, depth: 1, height: 1 } }] }),
    ).toThrow(/width/)
    expect(() =>
      planRebuild({
        version: 1,
        ops: [{ op: 'extrude', id: 'e', distance: 5, profile: { points: [[0, 0]] } }],
      }),
    ).toThrow(/at least 3 points/)
    expect(() => parseFeatureDocument('not json')).toThrow(/not json/)
  })
})

describe.skip('OCCT WASM geometry (skipped: unit tests do not load replicad-opencascadejs)', () => {
  it('meshes a box', () => {
    // ReplicadKernel compiles the WASM on init inside the worker.
  })
})
