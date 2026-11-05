import { parseEdgeRefs } from '../edgeRefs.ts'
import type { CadDocument, CadFeature, CadSketch, SketchEntity } from './CadDocument.ts'
import type {
  AxisName,
  BooleanMode,
  Counterbore,
  EdgeTopologyRef,
  FeatureDocument,
  FeatureOp,
  HoleDirection,
  PlaneName,
  Profile2D,
} from '../kernel/types.ts'

/**
 * Converts a CAD document into the ops GeometryKernel.rebuild replays.
 *
 * Limits:
 * - Primitive x/y/z are ignored. The kernel builds boxes, cylinders, and
 *   spheres at the origin. Offsets stay on the feature for the properties panel.
 * - bothSides on a sketch extrude is two extrudes fused together.
 * - An extrude with cut true subtracts that solid from the previous body.
 * - params.edgeIds is a comma-separated edge list copied onto the fillet or
 *   chamfer op. params.edgeRefs is a JSON array of edge signatures copied
 *   beside it. The kernel fillets those edges. A fillet with neither list
 *   is an error, so a missing ref does not round every edge.
 * - A hole feature becomes a hole op. The kernel cuts a cylinder from the target.
 */

const AXES = new Set<string>(['X', 'Y', 'Z', '-X', '-Y', '-Z'])
const HOLE_DIRECTIONS = new Set<string>(['X', 'Y', 'Z', '-X', '-Y', '-Z', 'normal'])
const PLANES = new Set<string>(['XY', 'YZ', 'ZX', 'XZ', 'YX', 'ZY'])
const CIRCLE_SEGMENTS = 16

export interface FeatureConversion {
  document: FeatureDocument
  errors: Record<string, string>
  files: Record<string, Uint8Array>
}

interface LooseEntity {
  kind?: string
  params?: Record<string, number>
}

type Pt = [number, number]

export function toFeatureDocument(
  doc: CadDocument,
  stepFiles: Readonly<Record<string, Uint8Array>> = {},
): FeatureConversion {
  const ops: FeatureOp[] = []
  const errors: Record<string, string> = {}
  const files: Record<string, Uint8Array> = {}
  const produced = new Set<string>()
  let lastBody: string | null = null
  const limit = Math.min(doc.historyIndex, doc.features.length - 1)

  for (let index = 0; index <= limit; index += 1) {
    const feature = doc.features[index]
    if (!feature || feature.suppressed) continue
    try {
      const built = convertFeature(doc, feature, stepFiles, produced, lastBody)
      ops.push(...built.ops)
      if (built.file) files[built.file.id] = built.file.bytes
      for (const op of built.ops) produced.add(op.id)
      if (built.bodyId) lastBody = built.bodyId
    } catch (error) {
      errors[feature.id] = error instanceof Error ? error.message : String(error)
    }
  }

  return { document: { version: 1, ops }, errors, files }
}

/** Shape ids the viewport should draw. Inputs consumed by a later op stay hidden. */
export function visibleShapeIds(ops: readonly FeatureOp[]): string[] {
  const consumed = new Set<string>()
  for (const op of ops) {
    if (op.op === 'fillet' || op.op === 'chamfer' || op.op === 'hole') consumed.add(op.target)
    if (op.op === 'boolean') {
      consumed.add(op.target)
      consumed.add(op.tool)
    }
  }
  const ids: string[] = []
  for (const op of ops) {
    if (consumed.has(op.id) || op.id.includes('::')) continue
    ids.push(op.id)
  }
  return ids
}

export function ownerId(opId: string): string {
  const mark = opId.indexOf('::')
  return mark === -1 ? opId : opId.slice(0, mark)
}

interface Built {
  ops: FeatureOp[]
  file?: { id: string; bytes: Uint8Array }
  bodyId: string | null
}

function convertFeature(
  doc: CadDocument,
  feature: CadFeature,
  stepFiles: Readonly<Record<string, Uint8Array>>,
  produced: ReadonlySet<string>,
  lastBody: string | null,
): Built {
  switch (feature.kind) {
    case 'sketch':
      return { ops: [], bodyId: null }
    case 'box':
      return solid(feature.id, {
        op: 'primitive',
        id: feature.id,
        kind: 'box',
        params: {
          width: positive(feature, 'width', 20),
          depth: positive(feature, 'depth', 20),
          height: positive(feature, 'height', 20),
        },
      })
    case 'cylinder':
      return solid(feature.id, {
        op: 'primitive',
        id: feature.id,
        kind: 'cylinder',
        params: {
          radius: positive(feature, 'radius', 10),
          height: positive(feature, 'height', 20),
        },
      })
    case 'sphere':
      return solid(feature.id, {
        op: 'primitive',
        id: feature.id,
        kind: 'sphere',
        params: { radius: positive(feature, 'radius', 10) },
      })
    case 'extrude':
      return extrudeFeature(doc, feature, lastBody)
    case 'revolve':
      return revolveFeature(doc, feature)
    case 'fillet':
      return edgeFeature(feature, 'fillet', produced)
    case 'chamfer':
      return edgeFeature(feature, 'chamfer', produced)
    case 'hole':
      return holeFeature(feature, produced)
    case 'union':
      return booleanFeature(feature, 'fuse', produced)
    case 'cut':
      return booleanFeature(feature, 'cut', produced)
    case 'intersect':
      return booleanFeature(feature, 'intersect', produced)
    case 'import':
      return importFeature(feature, stepFiles)
    default:
      throw new Error(`unknown feature ${feature.kind}`)
  }
}

function solid(id: string, op: FeatureOp): Built {
  return { ops: [op], bodyId: id }
}

function extrudeFeature(doc: CadDocument, feature: CadFeature, lastBody: string | null): Built {
  const profile = profileFor(doc, feature)
  const distance = nonzero(feature, 'distance', 10, 'distance')
  const bothSides = flag(feature, 'bothSides')
  const cut = flag(feature, 'cut')
  const ops: FeatureOp[] = []

  let toolId = feature.id
  if (bothSides) {
    const pos = partId(feature.id, 'pos')
    const neg = partId(feature.id, 'neg')
    ops.push({ op: 'extrude', id: pos, profile, distance })
    ops.push({ op: 'extrude', id: neg, profile, distance: -distance })
    toolId = cut ? partId(feature.id, 'tool') : feature.id
    ops.push({ op: 'boolean', id: toolId, mode: 'fuse', target: pos, tool: neg })
  } else if (cut) {
    toolId = partId(feature.id, 'tool')
    ops.push({ op: 'extrude', id: toolId, profile, distance })
  } else {
    ops.push({ op: 'extrude', id: feature.id, profile, distance })
  }

  if (cut) {
    if (!lastBody) throw new Error('cut needs a previous body')
    if (lastBody === toolId) throw new Error('boolean target and tool must differ')
    ops.push({ op: 'boolean', id: feature.id, mode: 'cut', target: lastBody, tool: toolId })
  }

  return { ops, bodyId: feature.id }
}

function revolveFeature(doc: CadDocument, feature: CadFeature): Built {
  const profile = profileFor(doc, feature)
  const angle = angleOf(feature)
  const axis = axisOf(feature)
  const op: FeatureOp = {
    op: 'revolve',
    id: feature.id,
    profile,
    angle,
    ...(axis ? { axis } : {}),
  }
  return { ops: [op], bodyId: feature.id }
}

function edgeFeature(
  feature: CadFeature,
  op: 'fillet' | 'chamfer',
  produced: ReadonlySet<string>,
): Built {
  const target = text(feature, 'targetId') ?? text(feature, 'target')
  if (!target) throw new Error(`${op} needs a target feature`)
  if (!produced.has(target)) throw new Error(`unknown shape ${target}`)
  const edgeIds = edgeIdsOf(feature)
  const edgeRefs = edgeRefsOf(feature)
  if (edgeIds.length === 0 && edgeRefs.length === 0) {
    throw new Error(`${op} needs selected edges`)
  }
  const radius = positive(feature, 'radius', 4)
  const next: FeatureOp =
    op === 'fillet'
      ? {
          op: 'fillet',
          id: feature.id,
          target,
          radius,
          ...(edgeIds.length > 0 ? { edgeIds } : {}),
          ...(edgeRefs.length > 0 ? { edgeRefs } : {}),
        }
      : {
          op: 'chamfer',
          id: feature.id,
          target,
          radius,
          ...(edgeIds.length > 0 ? { edgeIds } : {}),
          ...(edgeRefs.length > 0 ? { edgeRefs } : {}),
        }
  return { ops: [next], bodyId: feature.id }
}

function holeFeature(feature: CadFeature, produced: ReadonlySet<string>): Built {
  const target = text(feature, 'targetId') ?? text(feature, 'target')
  if (!target) throw new Error('hole needs a target feature')
  if (!produced.has(target)) throw new Error(`unknown shape ${target}`)
  const diameter = requiredPositive(feature, 'diameter')
  const throughAll = flag(feature, 'throughAll')
  const depth = optionalDepth(feature)
  if (!throughAll && depth === undefined) throw new Error('hole depth is missing')
  const counterbore = counterboreOf(feature, diameter, depth, throughAll)
  const direction = holeDirectionOf(feature)
  const op: FeatureOp = {
    op: 'hole',
    id: feature.id,
    target,
    origin: [coord(feature, 'x'), coord(feature, 'y'), coord(feature, 'z')],
    diameter,
    ...(direction ? { direction } : {}),
    ...(depth !== undefined ? { depth } : {}),
    ...(throughAll ? { throughAll: true } : {}),
    ...(counterbore ? { counterbore } : {}),
  }
  return { ops: [op], bodyId: feature.id }
}

function booleanFeature(
  feature: CadFeature,
  mode: BooleanMode,
  produced: ReadonlySet<string>,
): Built {
  const target = text(feature, 'targetId') ?? text(feature, 'target')
  const tool = text(feature, 'toolId') ?? text(feature, 'tool')
  if (!target || !tool) throw new Error(`${mode} needs a target and a tool`)
  if (target === tool) throw new Error('boolean target and tool must differ')
  if (!produced.has(target)) throw new Error(`unknown shape ${target}`)
  if (!produced.has(tool)) throw new Error(`unknown shape ${tool}`)
  return {
    ops: [{ op: 'boolean', id: feature.id, mode, target, tool }],
    bodyId: feature.id,
  }
}

function importFeature(
  feature: CadFeature,
  stepFiles: Readonly<Record<string, Uint8Array>>,
): Built {
  const bytes = stepFiles[feature.id]
  if (!bytes || bytes.byteLength === 0) throw new Error(`missing STEP bytes for ${feature.id}`)
  const name = text(feature, 'fileName') ?? feature.name
  if (!name) throw new Error('STEP import needs a name')
  return {
    ops: [{ op: 'importStep', id: feature.id, name }],
    file: { id: feature.id, bytes },
    bodyId: feature.id,
  }
}

function profileFor(doc: CadDocument, feature: CadFeature): Profile2D {
  const sketchId = feature.sketchId ?? text(feature, 'sketchId')
  if (!sketchId) throw new Error('extrude needs a sketch')
  const sketchFeature = doc.features.find((item) => item.id === sketchId)
  if (sketchFeature?.kind === 'sketch') {
    const index = doc.features.indexOf(sketchFeature)
    if (sketchFeature.suppressed) throw new Error('sketch is suppressed')
    if (index > doc.historyIndex) throw new Error('sketch is rolled back')
  }
  const sketch =
    doc.sketches.find((item) => item.id === sketchId) ??
    doc.sketches.find((item) => item.id === sketchFeature?.sketchId)
  if (!sketch) throw new Error(`unknown sketch ${sketchId}`)
  return profileFromSketch(sketch)
}

export function profileFromSketch(sketch: CadSketch): Profile2D {
  const plane = planeOf(sketch.plane)
  const entities = sketch.entities as LooseEntity[]
  const rect = entities.find((entity) => entity.kind === 'rect')
  if (rect) return { points: rectPoints(rect), ...(plane ? { plane } : {}) }
  const linear = entities.filter((entity) => entity.kind === 'line' || entity.kind === 'arc')
  if (linear.length > 0) {
    return { points: chainLines(segmentsOf(linear)), ...(plane ? { plane } : {}) }
  }
  const circle = entities.find((entity) => entity.kind === 'circle')
  if (circle) return { points: circlePoints(circle), ...(plane ? { plane } : {}) }
  const points = entities.filter((entity) => entity.kind === 'point')
  if (points.length >= 3) return { points: pointList(points), ...(plane ? { plane } : {}) }
  throw new Error('sketch has no closed profile')
}

function planeOf(value: string | undefined): PlaneName | undefined {
  if (!value) return undefined
  if (!PLANES.has(value)) throw new Error('unknown profile plane')
  return value as PlaneName
}

function rectPoints(entity: LooseEntity): Pt[] {
  const x = field(entity, 'x') ?? 0
  const y = field(entity, 'y') ?? 0
  const width = requiredField(entity, 'width')
  const height = requiredField(entity, 'height')
  if (width === 0 || height === 0) throw new Error('sketch has no closed profile')
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ]
}

function circlePoints(entity: LooseEntity): Pt[] {
  const cx = field(entity, 'cx') ?? field(entity, 'x') ?? 0
  const cy = field(entity, 'cy') ?? field(entity, 'y') ?? 0
  const radius = field(entity, 'radius') ?? field(entity, 'r')
  if (radius === undefined || radius <= 0) throw new Error('sketch has no closed profile')
  const points: Pt[] = []
  for (let index = 0; index < CIRCLE_SEGMENTS; index += 1) {
    const angle = (index / CIRCLE_SEGMENTS) * Math.PI * 2
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)])
  }
  return points
}

function segmentsOf(entities: LooseEntity[]): Array<[Pt, Pt]> {
  const segments: Array<[Pt, Pt]> = []
  for (const entity of entities) {
    if (entity.kind === 'line') {
      const x1 = requiredField(entity, 'x1')
      const y1 = requiredField(entity, 'y1')
      const x2 = requiredField(entity, 'x2')
      const y2 = requiredField(entity, 'y2')
      segments.push([
        [x1, y1],
        [x2, y2],
      ])
      continue
    }
    const samples = arcSamples(entity)
    for (let index = 0; index < samples.length - 1; index += 1) {
      const start = samples[index]
      const end = samples[index + 1]
      if (start && end) segments.push([start, end])
    }
  }
  return segments
}

function arcSamples(entity: LooseEntity): Pt[] {
  const cx = field(entity, 'cx') ?? 0
  const cy = field(entity, 'cy') ?? 0
  const radius = field(entity, 'radius')
  if (radius === undefined || radius <= 0) throw new Error('sketch has no closed profile')
  let start = field(entity, 'startAngle') ?? 0
  let end = field(entity, 'endAngle') ?? 0
  if (Math.abs(start) > Math.PI * 2 || Math.abs(end) > Math.PI * 2) {
    start = (start * Math.PI) / 180
    end = (end * Math.PI) / 180
  }
  const sweep = end - start
  const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 8)))
  const points: Pt[] = []
  for (let index = 0; index <= steps; index += 1) {
    const angle = start + (sweep * index) / steps
    points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)])
  }
  return points
}

function chainLines(segments: Array<[Pt, Pt]>): Pt[] {
  if (segments.length === 0) throw new Error('sketch has no closed profile')
  const pending = segments.slice()
  const seed = pending.shift()
  if (!seed) throw new Error('sketch has no closed profile')
  const points: Pt[] = [seed[0], seed[1]]
  let closed = near(seed[0], seed[1])
  while (!closed && pending.length > 0) {
    const end = points[points.length - 1]
    if (!end) break
    const index = pending.findIndex((segment) => near(segment[0], end) || near(segment[1], end))
    if (index < 0) break
    const removed = pending.splice(index, 1)[0]
    if (!removed) break
    const next = near(removed[0], end) ? removed[1] : removed[0]
    if (near(next, points[0]!)) {
      closed = true
      break
    }
    points.push(next)
  }
  if (!closed || pending.length > 0) throw new Error('sketch profile is not closed')
  if (points.length < 3) throw new Error('profile needs at least 3 points')
  return points
}

function pointList(entities: LooseEntity[]): Pt[] {
  const points = entities.map(
    (entity) => [requiredField(entity, 'x'), requiredField(entity, 'y')] as Pt,
  )
  const first = points[0]
  const last = points[points.length - 1]
  if (first && last && near(first, last)) points.pop()
  if (points.length < 3) throw new Error('profile needs at least 3 points')
  return points
}

function near(a: Pt, b: Pt): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) <= 1e-6
}

function field(entity: LooseEntity, key: string): number | undefined {
  const fromParams = entity.params?.[key]
  if (typeof fromParams === 'number' && Number.isFinite(fromParams)) return fromParams
  const direct = (entity as Record<string, unknown>)[key]
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct
  return undefined
}

function requiredField(entity: LooseEntity, key: string): number {
  const value = field(entity, key)
  if (value === undefined) throw new Error('sketch line is missing points')
  return value
}

function requiredPositive(feature: CadFeature, key: string): number {
  const value = feature.params[key]
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`)
  }
  return value
}

function optionalDepth(feature: CadFeature): number | undefined {
  const value = feature.params.depth
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error('depth must be a positive number')
  }
  return value
}

function coord(feature: CadFeature, key: string): number {
  const value = feature.params[key]
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`hole ${key} must be a finite number`)
  }
  return value
}

function holeDirectionOf(feature: CadFeature): HoleDirection | undefined {
  const raw = feature.params.direction
  if (raw === undefined || raw === '') return undefined
  if (typeof raw === 'string' && HOLE_DIRECTIONS.has(raw)) return raw as HoleDirection
  throw new Error('unknown hole direction')
}

function counterboreOf(
  feature: CadFeature,
  diameter: number,
  depth: number | undefined,
  throughAll: boolean,
): Counterbore | undefined {
  const boreDiameter = feature.params.cboreDiameter
  const boreDepth = feature.params.cboreDepth
  if (boreDiameter === undefined && boreDepth === undefined) return undefined
  if (boreDiameter === 0 && boreDepth === 0) return undefined
  if (boreDiameter === 0 || boreDepth === 0) return undefined
  if (typeof boreDiameter !== 'number' || typeof boreDepth !== 'number') {
    throw new Error('counterbore needs a diameter and a depth')
  }
  if (!Number.isFinite(boreDiameter) || boreDiameter <= 0) {
    throw new Error('counterbore diameter must be a positive number')
  }
  if (!Number.isFinite(boreDepth) || boreDepth <= 0) {
    throw new Error('counterbore depth must be a positive number')
  }
  if (boreDiameter <= diameter) throw new Error('counterbore diameter must be larger than the hole')
  if (!throughAll && depth !== undefined && boreDepth >= depth) {
    throw new Error('counterbore depth must be shorter than the hole')
  }
  return { diameter: boreDiameter, depth: boreDepth }
}

function positive(feature: CadFeature, key: string, fallback: number): number {
  const value = feature.params[key]
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${key} must be a positive number`)
  }
  return value
}

function nonzero(feature: CadFeature, key: string, fallback: number, label: string): number {
  const value = feature.params[key]
  const number = value === undefined ? fallback : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number === 0) {
    throw new Error(`${label} must be a non-zero finite number`)
  }
  return number
}

function flag(feature: CadFeature, key: string): boolean {
  const value = feature.params[key]
  return value === true || value === 'true'
}

function text(feature: CadFeature, key: string): string | null {
  const value = feature.params[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function edgeRefsOf(feature: CadFeature): EdgeTopologyRef[] {
  const raw = feature.params.edgeRefs
  if (typeof raw !== 'string' || raw.trim() === '') return []
  return parseEdgeRefs(raw).filter((ref): ref is EdgeTopologyRef => ref.kind === 'edge')
}

function edgeIdsOf(feature: CadFeature): number[] {
  const raw = feature.params.edgeIds
  if (typeof raw !== 'string' || raw.trim() === '') return []
  const ids: number[] = []
  for (const part of raw.split(',')) {
    const token = part.trim()
    if (!token) continue
    const value = Number(token)
    if (!Number.isInteger(value) || value < 0) {
      throw new Error('edgeIds must be comma-separated indexes')
    }
    ids.push(value)
  }
  return ids
}

function axisOf(feature: CadFeature): AxisName | undefined {
  const raw = feature.params.axis
  if (raw === undefined || raw === '') return undefined
  if (typeof raw === 'string' && AXES.has(raw)) return raw as AxisName
  throw new Error('unknown revolve axis')
}

function angleOf(feature: CadFeature): number {
  const value = feature.params.angle
  const angle = value === undefined ? 360 : value
  if (
    typeof angle !== 'number' ||
    !Number.isFinite(angle) ||
    angle === 0 ||
    Math.abs(angle) > 360
  ) {
    throw new Error('revolve angle must be within 360 degrees')
  }
  return angle
}

function partId(featureId: string, role: string): string {
  return `${featureId}::${role}`
}

export type { SketchEntity }
