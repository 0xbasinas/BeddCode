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
        ops: [{ op: 'boolean', id: 'b', mode: 'cut', target: 'gone', tool: 'other' }],
      }),
    ).toThrow('boolean target gone is missing')
    expect(() =>
      planRebuild({
        version: 1,
        ops: [box, { op: 'boolean', id: 'b', mode: 'fuse', target: 'base' }],
      }),
    ).toThrow('boolean tool is missing')
    expect(() =>
      planRebuild({ version: 1, ops: [{ op: 'revolve', id: 'r', angle: 90, profile: null }] }),
    ).toThrow('revolve profile is missing')
    expect(() =>
      planRebuild({
        version: 1,
        ops: [
          {
            op: 'revolve',
            id: 'r',
            angle: 90,
            axis: '',
            profile: {
              points: [
                [1, 0],
                [2, 0],
                [2, 1],
              ],
            },
          },
        ],
      }),
    ).toThrow('revolve axis is missing')
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

  it('plans bothSides extrude and fillet edge ids', () => {
    const doc = {
      version: 1 as const,
      ops: [
        box,
        {
          op: 'extrude' as const,
          id: 'slab',
          distance: -6,
          bothSides: true,
          profile: {
            points: [
              [0, 0],
              [4, 0],
              [4, 2],
            ] as [number, number][],
          },
        },
        { op: 'fillet' as const, id: 'round', target: 'base', radius: 0.5, edgeIds: [11, 4] },
        { op: 'chamfer' as const, id: 'bevel', target: 'slab', radius: 0.2, edgeIds: [2] },
      ],
    }
    const ops = planRebuild(doc)
    expect(ops[1]).toEqual({
      op: 'extrude',
      id: 'slab',
      distance: -6,
      bothSides: true,
      profile: {
        points: [
          [0, 0],
          [4, 0],
          [4, 2],
        ],
      },
    })
    expect(ops[2]).toEqual({
      op: 'fillet',
      id: 'round',
      target: 'base',
      radius: 0.5,
      edgeIds: [11, 4],
    })
    expect(ops[3]).toEqual({
      op: 'chamfer',
      id: 'bevel',
      target: 'slab',
      radius: 0.2,
      edgeIds: [2],
    })
    const text = serializeFeatureDocument(doc)
    expect(serializeFeatureDocument(parseFeatureDocument(text))).toBe(text)
    expect(text).toContain('"bothSides":true')
    expect(text).toContain('"edgeIds":[11,4]')
  })

  it('omits default extrude flags and empty edge id lists', () => {
    const ops = planRebuild({
      version: 1,
      ops: [
        box,
        {
          op: 'extrude',
          id: 'e',
          distance: 5,
          bothSides: false,
          cut: false,
          profile: {
            points: [
              [0, 0],
              [1, 0],
              [1, 1],
            ],
          },
        },
        { op: 'fillet', id: 'f', target: 'base', radius: 1, edgeIds: [] },
      ],
    })
    expect(ops[1]).not.toHaveProperty('bothSides')
    expect(ops[1]).not.toHaveProperty('cut')
    expect(ops[2]).not.toHaveProperty('edgeIds')
  })

  it('plans an extrude that cuts an earlier body', () => {
    const ops = planRebuild({
      version: 1,
      ops: [
        box,
        {
          op: 'extrude',
          id: 'pocket',
          distance: 12,
          cut: true,
          target: 'base',
          profile: {
            points: [
              [1, 1],
              [3, 1],
              [3, 3],
            ],
          },
        },
      ],
    })
    expect(ops[1]).toMatchObject({ op: 'extrude', cut: true, target: 'base', distance: 12 })
    expect(() =>
      planRebuild({
        version: 1,
        ops: [
          {
            op: 'extrude',
            id: 'hole',
            distance: 5,
            cut: true,
            profile: {
              points: [
                [0, 0],
                [1, 0],
                [1, 1],
              ],
            },
          },
        ],
      }),
    ).toThrow('extrude cut target is missing')
    expect(() =>
      planRebuild({
        version: 1,
        ops: [
          box,
          {
            op: 'extrude',
            id: 'hole',
            distance: 5,
            target: 'base',
            profile: {
              points: [
                [0, 0],
                [1, 0],
                [1, 1],
              ],
            },
          },
        ],
      }),
    ).toThrow('extrude target requires cut')
    expect(() =>
      planRebuild({
        version: 1,
        ops: [box, { op: 'fillet', id: 'f', target: 'base', radius: 1, edgeIds: [1.5] }],
      }),
    ).toThrow('edgeIds must be an array of integers')
  })
})
