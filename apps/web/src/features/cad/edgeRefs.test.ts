import { describe, expect, it } from 'vitest'
import {
  edgeSignature,
  mergeEdgeParams,
  parseEdgeIds,
  parseEdgeRefs,
  serializeEdgeIds,
  serializeEdgeRefs,
  signatureForEdge,
  type TopologyRef,
} from './edgeRefs.ts'

describe('edge refs', () => {
  it('signs a straight edge at its midpoint', () => {
    const positions = new Float32Array([0, 0, 0, 10, 0, 0])
    expect(edgeSignature(positions, 0, 2)).toEqual({
      kind: 'edge',
      mid: [5, 0, 0],
      dir: [1, 0, 0],
      length: 10,
    })
  })

  it('orients the direction into a stable hemisphere and rounds to 0.01 mm', () => {
    const positions = new Float32Array([10.004, 1, 2, 0, 1, 2])
    const ref = edgeSignature(positions, 0, 2)
    expect(ref).toEqual({
      kind: 'edge',
      mid: [5, 1, 2],
      dir: [1, 0, 0],
      length: 10,
    })
  })

  it('reads the signature from an edge group on the mesh', () => {
    const mesh = {
      edgeGroups: [{ start: 2, count: 2, edgeId: 11 }],
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, 0]),
    }
    const found = signatureForEdge(mesh, undefined, 2)
    expect(found?.edgeId).toBe(11)
    expect(found?.ref).toMatchObject({ mid: [0, 2, 0], length: 4 })
  })

  it('resolves segment-based groups in vertex space and prefers the picked edge id', () => {
    const mesh = {
      edgeGroups: [
        { start: 0, count: 1, edgeId: 10 },
        { start: 1, count: 1, edgeId: 11 },
        { start: 2, count: 1, edgeId: 12 },
      ],
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0, 0, 0, 6]),
    }
    expect(signatureForEdge(mesh, 11, 2)).toMatchObject({ edgeId: 11, ref: { length: 4 } })
    expect(signatureForEdge(mesh, undefined, 2)).toMatchObject({ edgeId: 11, ref: { length: 4 } })
  })

  it('serializes ids and refs, then merges another edge', () => {
    const first: TopologyRef = { kind: 'edge', mid: [1, 0, 0], dir: [0, 0, 1], length: 2 }
    const second: TopologyRef = { kind: 'edge', mid: [0, 3, 0], dir: [1, 0, 0], length: 6 }
    expect(serializeEdgeIds([11, 4])).toBe('11,4')
    expect(parseEdgeIds('11, 4')).toEqual([11, 4])
    expect(parseEdgeRefs(serializeEdgeRefs([first]))).toEqual([first])

    const merged = mergeEdgeParams('11', serializeEdgeRefs([first]), { edgeId: 4, ref: second })
    expect(merged.edgeIds).toBe('11,4')
    expect(parseEdgeRefs(merged.edgeRefs ?? '')).toEqual([first, second])
    expect(
      mergeEdgeParams(merged.edgeIds, merged.edgeRefs, { edgeId: 4, ref: second }).edgeIds,
    ).toBe('11,4')
  })

  it('drops refs when a later pick has no signature', () => {
    const first: TopologyRef = { kind: 'edge', mid: [1, 0, 0], dir: [0, 0, 1], length: 2 }
    const merged = mergeEdgeParams('11', serializeEdgeRefs([first]), { edgeId: 9, ref: null })
    expect(merged).toEqual({ edgeIds: '11,9' })
  })

  it('rejects a broken edge ref list', () => {
    expect(() => parseEdgeIds('3,nope')).toThrow(/comma-separated/)
    expect(() => parseEdgeRefs('{')).toThrow(/JSON array/)
    expect(() => parseEdgeRefs('{"kind":"face"}')).toThrow(/JSON array/)
  })
})
