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
import type { AnyShape, Shape3D } from '../vendor/replicad'
import type { GeometryKernel } from './GeometryKernel'
import { exactBuffer } from './buffers'
import { planRebuild } from './featureOps'
import type {
  AxisName,
  BBox,
  BooleanMode,
  FeatureDocument,
  FeatureOp,
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

function toMesh(shape: Shape3D): MeshBuffer {
  const raw = shape.mesh()
  const normals =
    raw.normals.length === raw.vertices.length ? raw.normals : raw.vertices.map(() => 0)
  return {
    positions: Float32Array.from(raw.vertices),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(raw.triangles),
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
    const oc = await initOC({ locateFile: () => wasmUrl })
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

  async extrude(profile: Profile2D, distance: number, id?: string): Promise<ShapeResult> {
    this.assertReady()
    const op = planRebuild({
      version: 1,
      ops: [{ op: 'extrude', id: id ?? 'check', profile, distance }],
    })[0]
    if (!op || op.op !== 'extrude') throw new Error('profile is missing')
    const shape = solidFromProfile(op.profile, (sketch) => sketch.extrude(op.distance))
    return this.keep(shape, id)
  }

  async revolve(
    profile: Profile2D,
    angle: number,
    axis?: AxisName,
    id?: string,
  ): Promise<ShapeResult> {
    this.assertReady()
    const op = planRebuild({
      version: 1,
      ops: [{ op: 'revolve', id: id ?? 'check', profile, angle, ...(axis ? { axis } : {}) }],
    })[0]
    if (!op || op.op !== 'revolve') throw new Error('profile is missing')
    const shape = solidFromProfile(op.profile, (sketch) =>
      sketch.revolve(op.axis ?? 'Z', { angle: op.angle }),
    )
    return this.keep(shape, id)
  }

  async fillet(targetId: string, radius: number, id?: string): Promise<ShapeResult> {
    this.assertReady()
    planRebuild({
      version: 1,
      ops: [
        { op: 'primitive', id: targetId, kind: 'sphere', params: { radius: 1 } },
        { op: 'fillet', id: id ?? 'check', target: targetId, radius },
      ],
    })
    return this.keep(asSolid(this.require(targetId).fillet(radius)), id)
  }

  async chamfer(targetId: string, radius: number, id?: string): Promise<ShapeResult> {
    this.assertReady()
    planRebuild({
      version: 1,
      ops: [
        { op: 'primitive', id: targetId, kind: 'sphere', params: { radius: 1 } },
        { op: 'chamfer', id: id ?? 'check', target: targetId, radius },
      ],
    })
    return this.keep(asSolid(this.require(targetId).chamfer(radius)), id)
  }

  async boolean(
    mode: BooleanMode,
    targetId: string,
    toolId: string,
    id?: string,
  ): Promise<ShapeResult> {
    this.assertReady()
    if (targetId === toolId) throw new Error('boolean target and tool must differ')
    planRebuild({
      version: 1,
      ops: [
        { op: 'primitive', id: targetId, kind: 'sphere', params: { radius: 1 } },
        { op: 'primitive', id: toolId, kind: 'sphere', params: { radius: 1 } },
        { op: 'boolean', id: id ?? 'check', mode, target: targetId, tool: toolId },
      ],
    })
    const target = this.require(targetId)
    const tool = this.require(toolId)
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
        return this.extrude(op.profile, op.distance, op.id)
      case 'revolve':
        return this.revolve(op.profile, op.angle, op.axis, op.id)
      case 'fillet':
        return this.fillet(op.target, op.radius, op.id)
      case 'chamfer':
        return this.chamfer(op.target, op.radius, op.id)
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

  private require(id: string): Shape3D {
    const shape = this.shapes.get(id)
    if (!shape) throw new Error(`unknown shape ${id}`)
    return shape
  }

  private assertReady(): void {
    if (!this.ready) throw new Error('geometry kernel is not initialised')
  }
}
