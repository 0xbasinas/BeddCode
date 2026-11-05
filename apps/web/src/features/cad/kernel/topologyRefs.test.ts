import { describe, expect, it } from 'vitest'
import type { MeshBuffer } from './types.ts'
import {
  edgeCandidatesFromMesh,
  edgeRefFromMesh,
  faceCandidatesFromMesh,
  matchEdgeRefs,
  matchFaceRefs,
} from './topologyRefs.ts'

const straight: MeshBuffer = {
  positions: new Float32Array(0),
  normals: new Float32Array(0),
  indices: new Uint32Array(0),
  edges: {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 0, 8]),
  },
  edgeGroups: [
    { start: 0, count: 2, edgeId: 11 },
    { start: 2, count: 2, edgeId: 12 },
  ],
}

describe('edge topology refs', () => {
  it('builds a rounded signature from an edge polyline', () => {
    const group = straight.edgeGroups?.[0]
    expect(group).toBeDefined()
    expect(edgeRefFromMesh(straight, group!)).toEqual({
      kind: 'edge',
      mid: [5, 0, 0],
      dir: [1, 0, 0],
      length: 10,
    })
    const vertical = straight.edgeGroups?.[1]
    expect(edgeRefFromMesh(straight, vertical!)).toEqual({
      kind: 'edge',
      mid: [0, 0, 4],
      dir: [0, 0, 1],
      length: 8,
    })
  })

  it('matches a flipped direction and a midpoint inside the rounding slack', () => {
    const candidates = edgeCandidatesFromMesh(straight)
    expect(
      matchEdgeRefs([{ kind: 'edge', mid: [5, 0, 0], dir: [-1, 0, 0], length: 10 }], candidates),
    ).toEqual([11])
    expect(
      matchEdgeRefs(
        [{ kind: 'edge', mid: [5.01, 0, 0], dir: [1, 0, 0], length: 10.01 }],
        candidates,
      ),
    ).toEqual([11])
  })

  it('matches several edges and keeps their order', () => {
    const candidates = edgeCandidatesFromMesh(straight)
    expect(
      matchEdgeRefs(
        [
          { kind: 'edge', mid: [0, 0, 4], dir: [0, 0, -1], length: 8 },
          { kind: 'edge', mid: [5, 0, 0], dir: [1, 0, 0], length: 10 },
        ],
        candidates,
      ),
    ).toEqual([12, 11])
  })

  it('fails when the signature matches nothing, is ambiguous, or is not an edge', () => {
    const candidates = edgeCandidatesFromMesh(straight)
    expect(
      matchEdgeRefs([{ kind: 'edge', mid: [40, 0, 0], dir: [1, 0, 0], length: 10 }], candidates),
    ).toEqual({ error: 'no edge matched the stored signature' })
    expect(
      matchEdgeRefs([{ kind: 'edge', mid: [5, 0, 0], dir: [0, 1, 0], length: 10 }], candidates),
    ).toEqual({ error: 'no edge matched the stored signature' })
    expect(
      matchEdgeRefs([{ kind: 'edge', mid: [5, 0, 0], dir: [1, 0, 0], length: 4 }], candidates),
    ).toEqual({ error: 'no edge matched the stored signature' })
    expect(matchEdgeRefs([], candidates)).toEqual({ error: 'no topology refs to match' })
    expect(
      matchEdgeRefs([{ kind: 'edge', mid: [5, 0, 0], dir: [1, 0, 0], length: 10 }], []),
    ).toEqual({ error: 'no edge matched the stored signature' })
    expect(
      matchEdgeRefs([{ kind: 'face', origin: [0, 0, 0], normal: [0, 0, 1] }], candidates),
    ).toEqual({ error: 'topology ref is not an edge' })
    expect(
      matchEdgeRefs(
        [{ kind: 'edge', mid: [0, 0, 0], dir: [1, 0, 0], length: 10 }],
        [
          { edgeId: 1, mid: [0, 0, 0], dir: [1, 0, 0], length: 10 },
          { edgeId: 2, mid: [0, 0, 0], dir: [-1, 0, 0], length: 10 },
        ],
      ),
    ).toEqual({ error: 'edge match is ambiguous' })
  })
})

describe('face topology refs', () => {
  it('matches a triangular face by centroid and normal', () => {
    const mesh: MeshBuffer = {
      positions: new Float32Array([0, 0, 0, 2, 0, 0, 0, 2, 0]),
      normals: new Float32Array(9),
      indices: new Uint32Array([0, 1, 2]),
      faceGroups: [{ start: 0, count: 3, faceId: 4 }],
    }
    const candidates = faceCandidatesFromMesh(mesh)
    expect(candidates).toEqual([{ faceId: 4, origin: [0.67, 0.67, 0], normal: [0, 0, 1] }])
    expect(
      matchFaceRefs([{ kind: 'face', origin: [0.67, 0.67, 0], normal: [0, 0, 1] }], candidates),
    ).toEqual([4])
    expect(
      matchFaceRefs([{ kind: 'face', origin: [5, 5, 0], normal: [0, 0, 1] }], candidates),
    ).toEqual({ error: 'no face matched the stored signature' })
  })
})
