import { describe, expect, it } from 'vitest'
import {
  faceFrameFromMesh,
  frameFromTriangle,
  holeAxisFromFacePoint,
  parseFeatureDocument,
  planRebuild,
  serializeFeatureDocument,
} from './featureOps.ts'

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

  it('serializes a hole and fillet edge refs', () => {
    const doc = {
      version: 1 as const,
      ops: [
        box,
        {
          op: 'hole' as const,
          id: 'drill',
          target: 'base',
          origin: [1, 2, 10] as [number, number, number],
          diameter: 4,
          throughAll: true,
          direction: '-Z' as const,
          counterbore: { diameter: 8, depth: 2 },
        },
        {
          op: 'fillet' as const,
          id: 'round',
          target: 'drill',
          radius: 0.5,
          edgeIds: [3],
          edgeRefs: [{ kind: 'edge' as const, mid: [0, 5, 10], dir: [1, 0, 0], length: 20 }],
        },
      ],
    }
    const ops = planRebuild(doc)
    expect(ops[1]).toEqual({
      op: 'hole',
      id: 'drill',
      target: 'base',
      origin: [1, 2, 10],
      diameter: 4,
      throughAll: true,
      direction: '-Z',
      counterbore: { diameter: 8, depth: 2 },
    })
    expect(ops[2]).toEqual({
      op: 'fillet',
      id: 'round',
      target: 'drill',
      radius: 0.5,
      edgeIds: [3],
      edgeRefs: [{ kind: 'edge', mid: [0, 5, 10], dir: [1, 0, 0], length: 20 }],
    })
    const text = serializeFeatureDocument(doc)
    expect(serializeFeatureDocument(parseFeatureDocument(text))).toBe(text)
    expect(text).toContain('"op":"hole"')
    expect(text).toContain('"edgeRefs":[')
    expect(text).toContain('"throughAll":true')
  })

  it('rejects a hole that cannot be cut and a bad edge ref', () => {
    expect(() =>
      planRebuild({
        version: 1,
        ops: [box, { op: 'hole', id: 'h', target: 'base', origin: [0, 0, 0], diameter: 4 }],
      }),
    ).toThrow('hole depth is missing')
    expect(() =>
      planRebuild({
        version: 1,
        ops: [
          {
            op: 'hole',
            id: 'h',
            target: 'missing',
            origin: [0, 0, 0],
            diameter: 4,
            throughAll: true,
          },
        ],
      }),
    ).toThrow(/unknown shape missing/)
    expect(() =>
      planRebuild({
        version: 1,
        ops: [
          box,
          {
            op: 'hole',
            id: 'h',
            target: 'base',
            origin: [0, 0, 1],
            diameter: 4,
            throughAll: true,
            direction: 'up',
          },
        ],
      }),
    ).toThrow('unknown hole direction')
    expect(() =>
      planRebuild({
        version: 1,
        ops: [
          box,
          {
            op: 'hole',
            id: 'h',
            target: 'base',
            origin: [0, 0, 1],
            diameter: 4,
            depth: 3,
            counterbore: { diameter: 4, depth: 1 },
          },
        ],
      }),
    ).toThrow('counterbore diameter must be larger than the hole')
    expect(() =>
      planRebuild({
        version: 1,
        ops: [
          box,
          {
            op: 'fillet',
            id: 'f',
            target: 'base',
            radius: 1,
            edgeRefs: [{ kind: 'face', mid: [0, 0, 0], dir: [0, 0, 1], length: 1 }],
          },
        ],
      }),
    ).toThrow('edge ref kind must be edge')
    const blind = planRebuild({
      version: 1,
      ops: [
        box,
        {
          op: 'hole',
          id: 'h',
          target: 'base',
          origin: [0, 0, 10],
          diameter: 5,
          depth: 4,
          throughAll: false,
        },
      ],
    })
    expect(blind[1]).toEqual({
      op: 'hole',
      id: 'h',
      target: 'base',
      origin: [0, 0, 10],
      diameter: 5,
      depth: 4,
    })
    expect(blind[1]).not.toHaveProperty('throughAll')
  })
})

describe('hole placement from a face point', () => {
  it('projects the click onto the face and drills into the solid', () => {
    const top = holeAxisFromFacePoint({
      point: [12, -3, 8.25],
      planeOrigin: [0, 0, 8],
      normal: [0, 0, 1],
    })
    expect(top.origin).toEqual([12, -3, 8])
    expect(top.direction).toBe('-Z')

    const side = holeAxisFromFacePoint({
      point: [20.4, 2, 4],
      planeOrigin: [20, 0, 0],
      normal: [1, 0, 0],
    })
    expect(side.origin).toEqual([20, 2, 4])
    expect(side.direction).toBe('-X')

    const tilted = holeAxisFromFacePoint({
      point: [1, 2, 3],
      normal: [1, 1, 1],
    })
    expect(tilted.direction).toBe('normal')
    expect(tilted.origin).toEqual([1, 2, 3])
    expect(() => holeAxisFromFacePoint({ point: [0, 0, 0], normal: [0, 0, 0] })).toThrow(/normal/)
  })

  it('reads the plane from the picked triangle', () => {
    const positions = new Float32Array([0, 0, 8, 10, 0, 8, 0, 10, 8])
    const frame = frameFromTriangle(positions, undefined, 0)
    expect(frame?.origin).toEqual([0, 0, 8])
    expect(frame?.normal[2]).toBeCloseTo(1)
    const indexed = faceFrameFromMesh(
      {
        positions,
        indices: new Uint32Array([0, 1, 2]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        faceGroups: [{ start: 0, count: 3, faceId: 7 }],
      },
      0,
      7,
    )
    expect(indexed?.normal[2]).toBeCloseTo(1)
    const axis = holeAxisFromFacePoint({
      point: [2, 2, 9],
      normal: indexed?.normal ?? [0, 0, 1],
      planeOrigin: indexed?.origin ?? [0, 0, 8],
    })
    expect(axis.origin[0]).toBeCloseTo(2)
    expect(axis.origin[1]).toBeCloseTo(2)
    expect(axis.origin[2]).toBeCloseTo(8)
    expect(axis.direction).toBe('-Z')
  })

  it('uses outward mesh normals when triangle winding is reversed', () => {
    const frame = faceFrameFromMesh({
      positions: new Float32Array([0, 0, 8, 0, 10, 8, 10, 0, 8]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    }, 0)
    expect(frame).not.toBeNull()
    expect(holeAxisFromFacePoint({
      point: [3.25, 4.5, 8.1],
      normal: frame!.normal,
      planeOrigin: frame!.origin,
    })).toEqual({ origin: [3.25, 4.5, 8], direction: '-Z' })
  })
})
