/** Triangle mesh handed to the main thread. Buffers are transferable. */
export interface MeshBuffer {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
}

export interface BBox {
  min: [number, number, number]
  max: [number, number, number]
}

export interface MeasureResult {
  volume: number
  area: number
  bbox: BBox
}

export interface ShapeResult {
  id: string
  mesh: MeshBuffer
  bbox: BBox
}

export type PrimitiveKind = 'box' | 'cylinder' | 'sphere'

/** Box centred on X/Y and standing on Z = 0. Sizes are millimetres. */
export interface BoxParams {
  width: number
  depth: number
  height: number
}

export interface CylinderParams {
  radius: number
  height: number
}

export interface SphereParams {
  radius: number
}

export type PrimitiveParams = BoxParams | CylinderParams | SphereParams

export type PlaneName = 'XY' | 'YZ' | 'ZX' | 'XZ' | 'YX' | 'ZY'

export type AxisName = 'X' | 'Y' | 'Z' | '-X' | '-Y' | '-Z'

/** Closed polygon in a sketch plane. At least three points, in order. */
export interface Profile2D {
  points: Array<[number, number]>
  plane?: PlaneName
}

export type BooleanMode = 'fuse' | 'cut' | 'intersect'

export type FeatureOp =
  | { op: 'primitive'; id: string; kind: PrimitiveKind; params: PrimitiveParams }
  | { op: 'extrude'; id: string; profile: Profile2D; distance: number }
  | { op: 'revolve'; id: string; profile: Profile2D; angle: number; axis?: AxisName }
  | { op: 'fillet'; id: string; target: string; radius: number }
  | { op: 'chamfer'; id: string; target: string; radius: number }
  | { op: 'boolean'; id: string; mode: BooleanMode; target: string; tool: string }
  | { op: 'importStep'; id: string; name: string }

/** Ordered feature list. Replay it with GeometryKernel.rebuild. */
export interface FeatureDocument {
  version: 1
  ops: FeatureOp[]
}
