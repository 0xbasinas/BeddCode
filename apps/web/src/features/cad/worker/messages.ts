import { exactBuffer } from '../kernel/buffers'
import type {
  AxisName,
  BooleanMode,
  EdgeTopologyRef,
  ExtrudeOptions,
  FeatureDocument,
  HoleParams,
  MeasureResult,
  PrimitiveKind,
  PrimitiveParams,
  Profile2D,
  ShapeResult,
} from '../kernel/types'

export type CadRequest =
  | { id: number; kind: 'init' }
  | { id: number; kind: 'createPrimitive'; primitive: PrimitiveKind; params: PrimitiveParams }
  | ({ id: number; kind: 'extrude'; profile: Profile2D; distance: number } & ExtrudeOptions)
  | { id: number; kind: 'revolve'; profile: Profile2D; angle: number; axis?: AxisName }
  | {
      id: number
      kind: 'fillet'
      targetId: string
      radius: number
      edgeIds?: number[]
      edgeRefs?: EdgeTopologyRef[]
    }
  | {
      id: number
      kind: 'chamfer'
      targetId: string
      radius: number
      edgeIds?: number[]
      edgeRefs?: EdgeTopologyRef[]
    }
  | ({ id: number; kind: 'hole'; targetId: string } & HoleParams)
  | { id: number; kind: 'boolean'; mode: BooleanMode; targetId: string; toolId: string }
  | { id: number; kind: 'measure'; targetId: string }
  | { id: number; kind: 'importStep'; bytes: ArrayBuffer }
  | { id: number; kind: 'exportStep'; targetId: string }
  | { id: number; kind: 'exportStl'; targetId: string }
  | {
      id: number
      kind: 'rebuild'
      document: FeatureDocument
      files: { id: string; bytes: ArrayBuffer }[]
    }
  | { id: number; kind: 'dispose' }

export type CadResponse =
  | { id: number; ok: true; type: 'ready' }
  | { id: number; ok: true; type: 'disposed' }
  | { id: number; ok: true; type: 'shape'; shape: ShapeResult }
  | { id: number; ok: true; type: 'shapes'; shapes: ShapeResult[] }
  | { id: number; ok: true; type: 'measure'; measure: MeasureResult }
  | { id: number; ok: true; type: 'bytes'; bytes: ArrayBuffer }
  | { id: number; ok: false; error: string }

export function meshTransfers(shape: ShapeResult): ArrayBuffer[] {
  const buffers = [
    exactBuffer(shape.mesh.positions),
    exactBuffer(shape.mesh.normals),
    exactBuffer(shape.mesh.indices),
  ]
  const edges = shape.mesh.edges?.positions
  if (edges) buffers.push(exactBuffer(edges))
  return [...new Set(buffers)]
}

export function responseTransfers(response: CadResponse): ArrayBuffer[] {
  if (!response.ok) return []
  if (response.type === 'shape') return meshTransfers(response.shape)
  if (response.type === 'shapes') return response.shapes.flatMap((shape) => meshTransfers(shape))
  if (response.type === 'bytes') return [response.bytes]
  return []
}
