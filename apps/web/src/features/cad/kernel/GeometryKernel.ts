import type {
  AxisName,
  BBox,
  BooleanMode,
  EdgeTopologyRef,
  ExtrudeOptions,
  FeatureDocument,
  HoleParams,
  MeasureResult,
  MeshBuffer,
  PrimitiveKind,
  PrimitiveParams,
  Profile2D,
  ShapeResult,
} from './types'

export type { BBox, MeasureResult, MeshBuffer, ShapeResult }

/**
 * CAD geometry kernel. Implementations run off the UI thread: building a solid
 * and meshing it can take long enough to freeze a pane.
 */
export interface GeometryKernel {
  init(): Promise<void>
  createPrimitive(kind: PrimitiveKind, params: PrimitiveParams): Promise<ShapeResult>
  extrude(profile: Profile2D, distance: number, options?: ExtrudeOptions): Promise<ShapeResult>
  revolve(profile: Profile2D, angle: number, axis?: AxisName): Promise<ShapeResult>
  /**
   * Fillets every edge, or only `edgeIds` (mesh edge hashes) when those hashes
   * still exist. When they miss, `edgeRefs` rematch the edges. A miss with no
   * match fails the op instead of filleting every edge.
   */
  fillet(
    targetId: string,
    radius: number,
    edgeIds?: number[],
    edgeRefs?: EdgeTopologyRef[],
  ): Promise<ShapeResult>
  /** Chamfers every edge, or the edges named by `edgeIds` / `edgeRefs`. */
  chamfer(
    targetId: string,
    radius: number,
    edgeIds?: number[],
    edgeRefs?: EdgeTopologyRef[],
  ): Promise<ShapeResult>
  /** Cuts a hole from `targetId`. The target shape stays in the kernel. */
  hole(targetId: string, params: HoleParams): Promise<ShapeResult>
  boolean(mode: BooleanMode, targetId: string, toolId: string): Promise<ShapeResult>
  measure(targetId: string): Promise<MeasureResult>
  importStep(bytes: Uint8Array): Promise<ShapeResult>
  exportStep(targetId: string): Promise<Uint8Array>
  exportStl(targetId: string): Promise<Uint8Array>
  /** Replays a feature document. `files` holds STEP bytes keyed by import op id. */
  rebuild(
    document: FeatureDocument,
    files?: Readonly<Record<string, Uint8Array>>,
  ): Promise<ShapeResult[]>
  dispose(): void
}
