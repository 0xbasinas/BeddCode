import initOC from 'replicad-opencascadejs'
import wasmUrl from 'replicad-opencascadejs/wasm?url'
import {
  draw,
  importSTEP,
  isShape3D,
  makeBaseBox,
  makeCylinder,
  makeSphere,
  measureShapeSurfaceProperties,
  measureShapeVolumeProperties,
  setOC,
} from '../vendor/replicad'
import type { AnyShape, Edge, Shape3D } from '../vendor/replicad'
import type { GeometryKernel } from './GeometryKernel'
import { exactBuffer } from './buffers'
import { planRebuild } from './featureOps'
import { edgeCandidatesFromMesh, matchEdgeRefs } from './topologyRefs'
import type {
  AxisName,
  BBox,
  BooleanMode,
  EdgeTopologyRef,
  ExtrudeOptions,
  FeatureDocument,
  FeatureOp,
  HoleParams,
  MeasureResult,
  MeshBuffer,
  PrimitiveKind,
  PrimitiveParams,
  Profile2D,
  ShapeResult,
  BoxParams,
  CylinderParams,
  SphereParams,
} from './types'

function asSolid(shape: AnyShape): Shape3D {
  if (!isShape3D(shape)) {
    shape.delete()
    throw new Error('result is not a 3D solid')
  }
  return shape
}

const AXIS_VECTOR: Record<AxisName, [number, number, number]> = {
  X: [1, 0, 0],
  Y: [0, 1, 0],
  Z: [0, 0, 1],
  '-X': [-1, 0, 0],
  '-Y': [0, -1, 0],
  '-Z': [0, 0, -1],
}

type HoleOp = Extract<FeatureOp, { op: 'hole' }>

/**
 * Vite rewrites the WASM import to `/@fs/<absolute path>` in Vitest. Node's
 * loader reads that with `fs`, so the prefix has to come off. Browsers fetch
 * the original URL.
 */
export function locateWasm(url: string): string {
  // Vite's `?url` import can keep `?import&url` on the asset path. Emscripten
  // must fetch the raw .wasm bytes, so strip that query. Vitest also rewrites
  // the path to `/@fs/<absolute>`; Node's loader needs the absolute form.
  const clean = url.replace(/[?#].*$/, '')
  const onNode =
    typeof process !== 'undefined' && !!process.versions?.node && typeof window === 'undefined'
  if (onNode && clean.startsWith('/@fs/')) {
    const path = clean.slice(4)
    return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path
  }
  return clean
}

function toMesh(shape: Shape3D): MeshBuffer {
  const raw = shape.mesh()
  const wires = shape.meshEdges()
  const normals =
    raw.normals.length === raw.vertices.length ? raw.normals : raw.vertices.map(() => 0)
  return {
    positions: Float32Array.from(raw.vertices),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(raw.triangles),
    faceGroups: raw.faceGroups.map((group) => ({
      start: group.start,
      count: group.count,
      faceId: group.faceId,
    })),
    edgeGroups: wires.edgeGroups.map((group) => ({
      start: group.start,
      count: group.count,
      edgeId: group.edgeId,
    })),
    edges: { positions: Float32Array.from(wires.lines) },
  }
}

/** A number fillets every edge. A function fillets only the given hashes. */
function radiiForEdges(
  radius: number,
  edgeIds?: number[],
): number | ((edge: Edge) => number | null) {
  if (!edgeIds || edgeIds.length === 0) return radius
  const wanted = new Set(edgeIds)
  return (edge) => (wanted.has(edge.hashCode) ? radius : null)
}

function extrudeSolid(profile: Profile2D, distance: number, bothSides: boolean): Shape3D {
  if (!bothSides) return solidFromProfile(profile, (sketch) => sketch.extrude(distance))
  const positive = solidFromProfile(profile, (sketch) => sketch.extrude(distance))
  let negative: Shape3D | null = null
  try {
    negative = solidFromProfile(profile, (sketch) => sketch.extrude(-distance))
    return asSolid(positive.fuse(negative))
  } finally {
    positive.delete()
    negative?.delete()
  }
}

function toBBox(shape: Shape3D): BBox {
  const box = shape.boundingBox
  const [min, max] = box.bounds
  box.delete()
  return {
    min: [min[0], min[1], min[2]],
    max: [max[0], max[1], max[2]],
  }
}

function profileDrawing(profile: Profile2D) {
  const first = profile.points[0]
  if (!first) throw new Error('profile needs at least 3 points')
  let pen = draw(first)
  for (let i = 1; i < profile.points.length; i++) {
    const point = profile.points[i]
    if (!point) continue
    pen = pen.lineTo(point)
  }
  return pen.close()
}

function solidFromProfile(
  profile: Profile2D,
  build: (sketch: ReturnType<ReturnType<typeof profileDrawing>['sketchOnPlane']>) => AnyShape,
): Shape3D {
  const drawing = profileDrawing(profile)
  const sketch = drawing.sketchOnPlane(profile.plane ?? 'XY')
  return asSolid(build(sketch))
}

async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer())
}

/**
 * Geometry kernel on vendored replicad. Call init() once so setOC receives the
 * OpenCascade WASM instance. The WASM file itself is not modified.
 */
export class ReplicadKernel implements GeometryKernel {
  private readonly shapes = new Map<string, Shape3D>()
  private seq = 0
  private ready = false
  private initPromise: Promise<void> | null = null

  init(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = this.load().catch((error: unknown) => {
        this.initPromise = null
        throw error
      })
    }
    return this.initPromise
  }

  private async load(): Promise<void> {
    const oc = await initOC({ locateFile: () => locateWasm(wasmUrl) })
    setOC(oc)
    this.ready = true
  }

  async createPrimitive(
    kind: PrimitiveKind,
    params: PrimitiveParams,
    id?: string,
  ): Promise<ShapeResult> {
    this.assertReady()
    const op = planRebuild({
      version: 1,
      ops: [{ op: 'primitive', id: id ?? 'check', kind, params }],
    })[0]
    if (!op || op.op !== 'primitive') throw new Error('unknown primitive')
    return this.keep(this.makePrimitive(op.kind, op.params), id)
  }

  async extrude(
    profile: Profile2D,
    distance: number,
    options?: ExtrudeOptions,
    id?: string,
  ): Promise<ShapeResult> {
    this.assertReady()
    const bothSides = options?.bothSides === true
    const cut = options?.cut === true
    const targetId = options?.target
    if (cut && !targetId) throw new Error('extrude cut target is missing')
    const ops: unknown[] = []
    if (cut && targetId) {
      ops.push({
        op: 'primitive' as const,
        id: targetId,
        kind: 'sphere' as const,
        params: { radius: 1 },
      })
    }
    ops.push({
      op: 'extrude' as const,
      id: id ?? 'check',
      profile,
      distance,
      ...(bothSides ? { bothSides: true } : {}),
      ...(cut && targetId ? { cut: true, target: targetId } : {}),
    })
    const op = planRebuild({ version: 1, ops }).at(-1)
    if (!op || op.op !== 'extrude') throw new Error('profile is missing')
    const target = op.cut && op.target ? this.require(op.target, 'extrude cut target') : null
    let solid = extrudeSolid(op.profile, op.distance, op.bothSides === true)
    if (target) {
      const tool = solid
      try {
        solid = asSolid(target.cut(tool))
      } finally {
        tool.delete()
      }
    }
    return this.keep(solid, id)
  }

  async revolve(
    profile: Profile2D,
    angle: number,
    axis?: AxisName,
    id?: string,
  ): Promise<ShapeResult> {
    this.assertReady()
    if (!profile || !Array.isArray(profile.points) || profile.points.length === 0) {
      throw new Error('revolve profile is missing')
    }
    const op = planRebuild({
      version: 1,
      ops: [{ op: 'revolve', id: id ?? 'check', profile, angle, ...(axis ? { axis } : {}) }],
    })[0]
    if (!op || op.op !== 'revolve') throw new Error('revolve profile is missing')
    let shape: Shape3D
    try {
      shape = solidFromProfile(op.profile, (sketch) =>
        sketch.revolve(op.axis ?? 'Z', { angle: op.angle }),
      )
    } catch (error) {
      if (error instanceof Error && /missing|axis/i.test(error.message)) throw error
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`revolve failed: ${detail}`)
    }
    return this.keep(shape, id)
  }

  async fillet(
    targetId: string,
    radius: number,
    edgeIds?: number[],
    edgeRefs?: EdgeTopologyRef[],
    id?: string,
  ): Promise<ShapeResult> {
    this.assertReady()
    planRebuild({
      version: 1,
      ops: [
        { op: 'primitive', id: targetId, kind: 'sphere', params: { radius: 1 } },
        {
          op: 'fillet',
          id: id ?? 'check',
          target: targetId,
          radius,
          ...(edgeIds && edgeIds.length > 0 ? { edgeIds } : {}),
          ...(edgeRefs && edgeRefs.length > 0 ? { edgeRefs } : {}),
        },
      ],
    })
    const shape = this.require(targetId, 'fillet target')
    const resolved = this.resolveEdgeIds(shape, edgeIds, edgeRefs, 'fillet')
    return this.keep(this.editEdges(shape, radius, resolved, 'fillet'), id)
  }

  async chamfer(
    targetId: string,
    radius: number,
    edgeIds?: number[],
    edgeRefs?: EdgeTopologyRef[],
    id?: string,
  ): Promise<ShapeResult> {
    this.assertReady()
    planRebuild({
      version: 1,
      ops: [
        { op: 'primitive', id: targetId, kind: 'sphere', params: { radius: 1 } },
        {
          op: 'chamfer',
          id: id ?? 'check',
          target: targetId,
          radius,
          ...(edgeIds && edgeIds.length > 0 ? { edgeIds } : {}),
          ...(edgeRefs && edgeRefs.length > 0 ? { edgeRefs } : {}),
        },
      ],
    })
    const shape = this.require(targetId, 'chamfer target')
    const resolved = this.resolveEdgeIds(shape, edgeIds, edgeRefs, 'chamfer')
    return this.keep(this.editEdges(shape, radius, resolved, 'chamfer'), id)
  }

  async hole(targetId: string, params: HoleParams, id?: string): Promise<ShapeResult> {
    this.assertReady()
    const planned = planRebuild({
      version: 1,
      ops: [
        { op: 'primitive', id: targetId, kind: 'sphere', params: { radius: 1 } },
        {
          op: 'hole',
          id: id ?? 'check',
          target: targetId,
          origin: params.origin,
          diameter: params.diameter,
          ...(params.direction ? { direction: params.direction } : {}),
          ...(params.depth !== undefined ? { depth: params.depth } : {}),
          ...(params.throughAll ? { throughAll: true } : {}),
          ...(params.counterbore ? { counterbore: params.counterbore } : {}),
        },
      ],
    }).at(-1)
    if (!planned || planned.op !== 'hole') throw new Error('hole is missing')
    const target = this.require(targetId, 'hole target')
    return this.keep(this.cutHole(target, planned), id)
  }

  async boolean(
    mode: BooleanMode,
    targetId: string,
    toolId: string,
    id?: string,
  ): Promise<ShapeResult> {
    this.assertReady()
    if (targetId === toolId) throw new Error('boolean target and tool must differ')
    if (!targetId) throw new Error('boolean target is missing')
    if (!toolId) throw new Error('boolean tool is missing')
    planRebuild({
      version: 1,
      ops: [
        { op: 'primitive', id: targetId, kind: 'sphere', params: { radius: 1 } },
        { op: 'primitive', id: toolId, kind: 'sphere', params: { radius: 1 } },
        { op: 'boolean', id: id ?? 'check', mode, target: targetId, tool: toolId },
      ],
    })
    const target = this.require(targetId, 'boolean target')
    const tool = this.require(toolId, 'boolean tool')
    const next =
      mode === 'fuse'
        ? target.fuse(tool)
        : mode === 'cut'
          ? target.cut(tool)
          : target.intersect(tool)
    return this.keep(asSolid(next), id)
  }

  async measure(targetId: string): Promise<MeasureResult> {
    this.assertReady()
    const shape = this.require(targetId)
    const volumeProps = measureShapeVolumeProperties(shape)
    const volume = volumeProps.volume
    volumeProps.delete()
    const areaProps = measureShapeSurfaceProperties(shape)
    const area = areaProps.area
    areaProps.delete()
    return { volume, area, bbox: toBBox(shape) }
  }

  async importStep(bytes: Uint8Array, id?: string): Promise<ShapeResult> {
    this.assertReady()
    const shape = asSolid(await importSTEP(new Blob([exactBuffer(bytes)])))
    return this.keep(shape, id)
  }

  async exportStep(targetId: string): Promise<Uint8Array> {
    this.assertReady()
    return bytesOf(this.require(targetId).blobSTEP())
  }

  async exportStl(targetId: string): Promise<Uint8Array> {
    this.assertReady()
    return bytesOf(this.require(targetId).blobSTL({ binary: true }))
  }

  async rebuild(
    document: FeatureDocument,
    files: Readonly<Record<string, Uint8Array>> = {},
  ): Promise<ShapeResult[]> {
    this.assertReady()
    const ops = planRebuild(document)
    const results: ShapeResult[] = []
    for (const op of ops) results.push(await this.apply(op, files))
    return results
  }

  dispose(): void {
    for (const shape of this.shapes.values()) shape.delete()
    this.shapes.clear()
  }

  private async apply(
    op: FeatureOp,
    files: Readonly<Record<string, Uint8Array>>,
  ): Promise<ShapeResult> {
    switch (op.op) {
      case 'primitive':
        return this.keep(this.makePrimitive(op.kind, op.params), op.id)
      case 'extrude':
        return this.extrude(
          op.profile,
          op.distance,
          { bothSides: op.bothSides, cut: op.cut, target: op.target },
          op.id,
        )
      case 'revolve':
        return this.revolve(op.profile, op.angle, op.axis, op.id)
      case 'fillet':
        return this.fillet(op.target, op.radius, op.edgeIds, op.edgeRefs, op.id)
      case 'chamfer':
        return this.chamfer(op.target, op.radius, op.edgeIds, op.edgeRefs, op.id)
      case 'hole':
        return this.hole(
          op.target,
          {
            origin: op.origin,
            diameter: op.diameter,
            ...(op.direction ? { direction: op.direction } : {}),
            ...(op.depth !== undefined ? { depth: op.depth } : {}),
            ...(op.throughAll ? { throughAll: true } : {}),
            ...(op.counterbore ? { counterbore: op.counterbore } : {}),
          },
          op.id,
        )
      case 'boolean':
        return this.boolean(op.mode, op.target, op.tool, op.id)
      case 'importStep': {
        const bytes = files[op.id]
        if (!bytes) throw new Error(`missing STEP bytes for ${op.id}`)
        return this.importStep(bytes, op.id)
      }
      default:
        throw new Error('unknown feature op')
    }
  }

  private makePrimitive(kind: PrimitiveKind, params: PrimitiveParams): Shape3D {
    if (kind === 'box') {
      const box = params as BoxParams
      return makeBaseBox(box.width, box.depth, box.height)
    }
    if (kind === 'cylinder') {
      const cylinder = params as CylinderParams
      return makeCylinder(cylinder.radius, cylinder.height)
    }
    const sphere = params as SphereParams
    return makeSphere(sphere.radius)
  }

  private keep(shape: Shape3D, id?: string): ShapeResult {
    const shapeId = id ?? `s${++this.seq}`
    if (this.shapes.has(shapeId)) {
      shape.delete()
      throw new Error(`duplicate feature id ${shapeId}`)
    }
    this.shapes.set(shapeId, shape)
    return { id: shapeId, mesh: toMesh(shape), bbox: toBBox(shape) }
  }

  /**
   * Hash match first. On a miss, rematch `edgeRefs` against the current mesh.
   * A miss that cannot be rematched throws. It does not fillet every edge.
   */
  private resolveEdgeIds(
    shape: Shape3D,
    edgeIds: number[] | undefined,
    edgeRefs: EdgeTopologyRef[] | undefined,
    kind: 'fillet' | 'chamfer',
  ): number[] | undefined {
    const wanted = edgeIds?.length ?? 0
    const refs = edgeRefs ?? []
    if (wanted === 0 && refs.length === 0) return undefined
    const mesh = toMesh(shape)
    const known = new Set((mesh.edgeGroups ?? []).map((group) => group.edgeId))
    if (wanted > 0 && edgeIds && edgeIds.every((id) => known.has(id))) return edgeIds
    if (refs.length > 0) {
      const matched = matchEdgeRefs(refs, edgeCandidatesFromMesh(mesh))
      if (!Array.isArray(matched)) throw new Error(`${kind} edges not found: ${matched.error}`)
      return matched
    }
    throw new Error(`${kind} edges not found`)
  }

  private cutHole(target: Shape3D, op: HoleOp): Shape3D {
    const direction = this.drillDirection(target, op)
    const margin = 0.5
    const origin = op.origin
    const start: [number, number, number] = [
      origin[0] - direction[0] * margin,
      origin[1] - direction[1] * margin,
      origin[2] - direction[2] * margin,
    ]
    const reach = op.throughAll ? this.span(target) + margin : (op.depth ?? 0) + margin
    if (!(reach > margin)) throw new Error('hole depth is missing')
    const tool = makeCylinder(op.diameter / 2, reach, start, direction)
    let cutter: Shape3D = tool
    let bore: Shape3D | null = null
    try {
      if (op.counterbore) {
        bore = makeCylinder(
          op.counterbore.diameter / 2,
          op.counterbore.depth + margin,
          start,
          direction,
        )
        const fused = asSolid(cutter.fuse(bore))
        cutter = fused
      }
      return asSolid(target.cut(cutter))
    } finally {
      if (cutter !== tool) tool.delete()
      cutter.delete()
      bore?.delete()
    }
  }

  /** Drill axis. `normal` goes into the solid, opposite the outward face normal. */
  private drillDirection(shape: Shape3D, op: HoleOp): [number, number, number] {
    if (op.direction === 'normal') {
      const outward = this.outwardNormal(shape, op.origin)
      if (!outward) return [0, 0, -1]
      return [-outward[0], -outward[1], -outward[2]]
    }
    if (!op.direction) return [0, 0, -1]
    return AXIS_VECTOR[op.direction]
  }

  private outwardNormal(
    shape: Shape3D,
    origin: [number, number, number],
  ): [number, number, number] | null {
    let bestDist = Number.POSITIVE_INFINITY
    let best: [number, number, number] | null = null
    for (const face of shape.faces) {
      let normal: { x: number; y: number; z: number; delete(): void } | null = null
      let center: { x: number; y: number; z: number; delete(): void } | null = null
      try {
        normal = face.normalAt(origin)
        center = face.center
        const length = Math.hypot(normal.x, normal.y, normal.z)
        if (length < 1e-9) continue
        const unit: [number, number, number] = [
          normal.x / length,
          normal.y / length,
          normal.z / length,
        ]
        const dist = Math.abs(
          (origin[0] - center.x) * unit[0] +
            (origin[1] - center.y) * unit[1] +
            (origin[2] - center.z) * unit[2],
        )
        if (dist < bestDist) {
          bestDist = dist
          best = unit
        }
      } catch {
        // Skip a face that cannot report a normal at this point.
      } finally {
        normal?.delete()
        center?.delete()
        face.delete()
      }
    }
    if (!best || bestDist > 0.25) return null
    return best
  }

  private span(shape: Shape3D): number {
    const box = toBBox(shape)
    return Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) + 1
  }

  private editEdges(
    shape: Shape3D,
    radius: number,
    edgeIds: number[] | undefined,
    kind: 'fillet' | 'chamfer',
  ): Shape3D {
    const config = radiiForEdges(radius, edgeIds)
    try {
      const next = kind === 'fillet' ? shape.fillet(config) : shape.chamfer(config)
      return asSolid(next)
    } catch (error) {
      if (error instanceof Error && error.message.includes('no edge was selected')) {
        throw new Error(`${kind} edges not found`)
      }
      throw error
    }
  }

  private require(id: string, label?: string): Shape3D {
    const shape = this.shapes.get(id)
    if (!shape) throw new Error(label ? `${label} ${id} is missing` : `unknown shape ${id}`)
    return shape
  }

  private assertReady(): void {
    if (!this.ready) throw new Error('geometry kernel is not initialised')
  }
}
