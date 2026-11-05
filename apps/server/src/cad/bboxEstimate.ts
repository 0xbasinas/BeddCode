import type { CadDocument, CadFeature, CadSketch } from './cadStore.ts'

/**
 * Axis-aligned box in millimetres. Matches the geometry kernel: X to the right,
 * Y back, Z up. A box or cylinder sits on Z = 0 and is centred on X and Y.
 * A sphere is centred on the origin.
 */
export interface EstimatedBBox {
  min: [number, number, number]
  max: [number, number, number]
}

interface FlatBox {
  minU: number
  minV: number
  maxU: number
  maxV: number
}

/**
 * Best-effort bounds from stored feature parameters. This is not a measurement
 * of a rebuilt solid: fillets, imports and revolves are skipped or copied from
 * their target, and booleans use the target boxes only.
 */
export function estimateBBox(doc: CadDocument, featureId?: string): EstimatedBBox | undefined {
  const chosen = featureId
    ? doc.features.filter((feature) => feature.id === featureId)
    : doc.features.filter(
        (feature, index) => index < doc.historyIndex && feature.suppressed !== true,
      )
  const boxes: EstimatedBBox[] = []
  for (const feature of chosen) {
    const box = featureBox(feature, doc, new Set())
    if (box) boxes.push(box)
  }
  return unionBoxes(boxes)
}

function featureBox(
  feature: CadFeature,
  doc: CadDocument,
  seen: Set<string>,
): EstimatedBBox | undefined {
  if (seen.has(feature.id)) return undefined
  seen.add(feature.id)
  const params = feature.params ?? {}
  switch (feature.type) {
    case 'box':
      return boxOf(params)
    case 'cylinder':
      return cylinderOf(params)
    case 'sphere':
      return sphereOf(params)
    case 'extrude':
      return extrudeOf(feature, doc)
    case 'fillet':
    case 'chamfer':
    case 'cut':
      return firstTarget(feature, doc, seen)
    case 'union':
      return unionBoxes(targetBoxes(feature, doc, seen))
    case 'intersect':
      return intersectBoxes(targetBoxes(feature, doc, seen))
    default:
      return undefined
  }
}

function boxOf(params: Record<string, unknown>): EstimatedBBox | undefined {
  const width = positive(params, 'width')
  const depth = positive(params, 'depth')
  const height = positive(params, 'height')
  if (width === undefined || depth === undefined || height === undefined) return undefined
  return shift({ min: [-width / 2, -depth / 2, 0], max: [width / 2, depth / 2, height] }, params)
}

function cylinderOf(params: Record<string, unknown>): EstimatedBBox | undefined {
  const radius = positive(params, 'radius')
  const height = positive(params, 'height')
  if (radius === undefined || height === undefined) return undefined
  return shift({ min: [-radius, -radius, 0], max: [radius, radius, height] }, params)
}

function sphereOf(params: Record<string, unknown>): EstimatedBBox | undefined {
  const radius = positive(params, 'radius')
  if (radius === undefined) return undefined
  return shift({ min: [-radius, -radius, -radius], max: [radius, radius, radius] }, params)
}

function extrudeOf(feature: CadFeature, doc: CadDocument): EstimatedBBox | undefined {
  const distance = finite(feature.params, 'distance')
  if (distance === undefined || distance === 0) return undefined
  const sketch = feature.sketchId
    ? doc.sketches.find((item) => item.id === feature.sketchId)
    : undefined
  const flat = sketch ? profileOf(sketch) : undefined
  if (!flat) return undefined
  const plane = sketch?.plane || text(feature.params, 'plane') || 'XY'
  return mapPlane(flat, distance, plane)
}

function profileOf(sketch: CadSketch): FlatBox | undefined {
  const parts: FlatBox[] = []
  for (const entity of sketch.entities) {
    const flat = entityBox(entity)
    if (flat) parts.push(flat)
  }
  if (!parts.length) return undefined
  return {
    minU: Math.min(...parts.map((part) => part.minU)),
    minV: Math.min(...parts.map((part) => part.minV)),
    maxU: Math.max(...parts.map((part) => part.maxU)),
    maxV: Math.max(...parts.map((part) => part.maxV)),
  }
}

function entityBox(entity: unknown): FlatBox | undefined {
  if (!entity || typeof entity !== 'object') return undefined
  const record = entity as Record<string, unknown>
  const params = recordOf(record.params) ?? record
  const type = String(record.type ?? record.kind ?? '').toLowerCase()
  if (type === 'rect' || type === 'rectangle') {
    const width = positive(params, 'width')
    const height = positive(params, 'height') ?? positive(params, 'depth')
    if (width === undefined || height === undefined) return undefined
    const cx = finite(params, 'x') ?? finite(params, 'cx') ?? 0
    const cy = finite(params, 'y') ?? finite(params, 'cy') ?? 0
    return {
      minU: cx - width / 2,
      maxU: cx + width / 2,
      minV: cy - height / 2,
      maxV: cy + height / 2,
    }
  }
  if (type === 'circle') {
    const radius = positive(params, 'radius') ?? positive(params, 'r')
    if (radius === undefined) return undefined
    const cx = finite(params, 'x') ?? finite(params, 'cx') ?? 0
    const cy = finite(params, 'y') ?? finite(params, 'cy') ?? 0
    return { minU: cx - radius, maxU: cx + radius, minV: cy - radius, maxV: cy + radius }
  }
  const points = pointList(record.points) ?? pointList(params.points)
  if (points?.length) {
    return {
      minU: Math.min(...points.map((point) => point[0])),
      maxU: Math.max(...points.map((point) => point[0])),
      minV: Math.min(...points.map((point) => point[1])),
      maxV: Math.max(...points.map((point) => point[1])),
    }
  }
  const x1 = finite(params, 'x1')
  const y1 = finite(params, 'y1')
  const x2 = finite(params, 'x2')
  const y2 = finite(params, 'y2')
  if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) return undefined
  return {
    minU: Math.min(x1, x2),
    maxU: Math.max(x1, x2),
    minV: Math.min(y1, y2),
    maxV: Math.max(y1, y2),
  }
}

function mapPlane(flat: FlatBox, distance: number, plane: string): EstimatedBBox {
  const near = Math.min(0, distance)
  const far = Math.max(0, distance)
  const name = plane.toUpperCase()
  if (name === 'YZ' || name === 'ZY') {
    return { min: [near, flat.minU, flat.minV], max: [far, flat.maxU, flat.maxV] }
  }
  if (name === 'ZX' || name === 'XZ') {
    return { min: [flat.minV, near, flat.minU], max: [flat.maxV, far, flat.maxU] }
  }
  return { min: [flat.minU, flat.minV, near], max: [flat.maxU, flat.maxV, far] }
}

function targetIds(params: Record<string, unknown>): string[] {
  const ids: string[] = []
  if (typeof params.target === 'string') ids.push(params.target)
  if (typeof params.feature === 'string') ids.push(params.feature)
  if (Array.isArray(params.targets)) {
    for (const id of params.targets) if (typeof id === 'string' && id) ids.push(id)
  }
  return ids
}

function firstTarget(
  feature: CadFeature,
  doc: CadDocument,
  seen: Set<string>,
): EstimatedBBox | undefined {
  const id = targetIds(feature.params)[0]
  if (!id) return undefined
  const target = doc.features.find((item) => item.id === id)
  if (!target) return undefined
  return featureBox(target, doc, seen)
}

function targetBoxes(feature: CadFeature, doc: CadDocument, seen: Set<string>): EstimatedBBox[] {
  const boxes: EstimatedBBox[] = []
  for (const id of targetIds(feature.params)) {
    const target = doc.features.find((item) => item.id === id)
    if (!target) continue
    const box = featureBox(target, doc, seen)
    if (box) boxes.push(box)
  }
  return boxes
}

function shift(box: EstimatedBBox, params: Record<string, unknown>): EstimatedBBox {
  const x = finite(params, 'x') ?? 0
  const y = finite(params, 'y') ?? 0
  const z = finite(params, 'z') ?? 0
  if (x === 0 && y === 0 && z === 0) return box
  return {
    min: [box.min[0] + x, box.min[1] + y, box.min[2] + z],
    max: [box.max[0] + x, box.max[1] + y, box.max[2] + z],
  }
}

function unionBoxes(boxes: EstimatedBBox[]): EstimatedBBox | undefined {
  const first = boxes[0]
  if (!first) return undefined
  const min: [number, number, number] = [first.min[0], first.min[1], first.min[2]]
  const max: [number, number, number] = [first.max[0], first.max[1], first.max[2]]
  for (const box of boxes.slice(1)) {
    min[0] = Math.min(min[0], box.min[0])
    min[1] = Math.min(min[1], box.min[1])
    min[2] = Math.min(min[2], box.min[2])
    max[0] = Math.max(max[0], box.max[0])
    max[1] = Math.max(max[1], box.max[1])
    max[2] = Math.max(max[2], box.max[2])
  }
  return { min, max }
}

function intersectBoxes(boxes: EstimatedBBox[]): EstimatedBBox | undefined {
  const first = boxes[0]
  if (!first) return undefined
  const min: [number, number, number] = [first.min[0], first.min[1], first.min[2]]
  const max: [number, number, number] = [first.max[0], first.max[1], first.max[2]]
  for (const box of boxes.slice(1)) {
    min[0] = Math.max(min[0], box.min[0])
    min[1] = Math.max(min[1], box.min[1])
    min[2] = Math.max(min[2], box.min[2])
    max[0] = Math.min(max[0], box.max[0])
    max[1] = Math.min(max[1], box.max[1])
    max[2] = Math.min(max[2], box.max[2])
  }
  if (min[0] > max[0] || min[1] > max[1] || min[2] > max[2]) return undefined
  return { min, max }
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

function finite(params: Record<string, unknown>, key: string): number | undefined {
  const value = params[key]
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

function positive(params: Record<string, unknown>, key: string): number | undefined {
  const value = finite(params, key)
  if (value === undefined || value <= 0) return undefined
  return value
}

function text(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  return typeof value === 'string' && value.trim() ? value : undefined
}

function pointList(value: unknown): Array<[number, number]> | undefined {
  if (!Array.isArray(value)) return undefined
  const points: Array<[number, number]> = []
  for (const point of value) {
    if (!Array.isArray(point)) return undefined
    const x = point[0]
    const y = point[1]
    if (typeof x !== 'number' || typeof y !== 'number') return undefined
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined
    points.push([x, y])
  }
  return points
}
