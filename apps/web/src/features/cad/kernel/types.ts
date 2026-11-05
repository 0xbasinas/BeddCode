/** One run of triangles (or edge vertices) that belong to a single face or edge. */
export interface MeshGroup {
  /** Index into the mesh index buffer, or a vertex index into the edge line buffer. */
  start: number
  count: number
}

export interface FaceGroup extends MeshGroup {
  /** OCCT shape hash of the face. Stable for picking on this mesh. */
  faceId: number
}

export interface EdgeGroup extends MeshGroup {
  /** OCCT shape hash of the edge. Pass these to fillet and chamfer. */
  edgeId: number
}

/**
 * Triangle mesh handed to the main thread. Buffers are transferable.
 * Face and edge groups are optional so older meshes still render.
 * `edges.positions` is a non-indexed line list (xyz pairs) for the wireframe.
 */
export interface MeshBuffer {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  faceGroups?: FaceGroup[]
  edgeGroups?: EdgeGroup[]
  edges?: { positions: Float32Array }
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

/**
 * Options for a direct extrude call. `bothSides` builds +distance and
 * -distance, then fuses them. `cut` does not keep the extrusion: it subtracts
 * that solid from `target` (a shape already in the kernel). Leave `cut` unset
 * to keep the extrusion as its own body and boolean it later.
 */
export interface ExtrudeOptions {
  bothSides?: boolean
  cut?: boolean
  target?: string
}

export type FeatureOp =
  | { op: 'primitive'; id: string; kind: PrimitiveKind; params: PrimitiveParams }
  | {
      op: 'extrude'
      id: string
      profile: Profile2D
      distance: number
      /** Extrude both ways along the sketch normal and fuse the two solids. */
      bothSides?: boolean
      /**
       * Subtract the extrusion from `target` instead of storing it as a body.
       * Requires `target`. A plain boolean op remains the other way to cut.
       */
      cut?: boolean
      target?: string
    }
  | { op: 'revolve'; id: string; profile: Profile2D; angle: number; axis?: AxisName }
  | { op: 'fillet'; id: string; target: string; radius: number; edgeIds?: number[] }
  | { op: 'chamfer'; id: string; target: string; radius: number; edgeIds?: number[] }
  | { op: 'boolean'; id: string; mode: BooleanMode; target: string; tool: string }
  | { op: 'importStep'; id: string; name: string }

/** Ordered feature list. Replay it with GeometryKernel.rebuild. */
export interface FeatureDocument {
  version: 1
  ops: FeatureOp[]
}
