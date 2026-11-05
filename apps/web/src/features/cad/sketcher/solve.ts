import type {
  PointRef,
  Sketch,
  SketchArc,
  SketchCircle,
  SketchConstraint,
  SketchDimension,
  SketchEntity,
  SketchLine,
  SketchPoint,
  SketchRect,
} from './types.ts'

const PASSES = 32
const EPS = 1e-9

interface Vec {
  x: number
  y: number
}

/**
 * Sequential constraint applier. Each pass writes driving dimensions, then geometric
 * constraints. Free coordinates stay as drawn. The last driving value wins if two
 * dimensions disagree.
 */
export function solveSketch(sketch: Sketch): Sketch {
  const entities = sketch.entities.map(cloneEntity)
  let previous = fingerprint(entities)
  for (let pass = 0; pass < PASSES; pass++) {
    for (const dimension of sketch.dimensions) applyDimension(entities, dimension)
    for (const constraint of sketch.constraints) applyConstraint(entities, constraint)
    const next = fingerprint(entities)
    if (next.every((value, index) => Math.abs(value - (previous[index] ?? 0)) < EPS)) break
    previous = next
  }
  return { ...sketch, entities }
}

function applyDimension(entities: SketchEntity[], dimension: SketchDimension): void {
  assertFinite(dimension.value, dimension.kind)
  if (dimension.kind === 'width' || dimension.kind === 'height') {
    if (dimension.value < 0) throw new Error(`${dimension.kind} cannot be negative`)
    const rect = expectRect(entities, dimension.entityId, dimension.kind)
    if (dimension.kind === 'width') rect.width = dimension.value
    else rect.height = dimension.value
    return
  }
  if (dimension.kind === 'radius') {
    if (dimension.value < 0) throw new Error('radius cannot be negative')
    setRadius(entities, dimension.entityId, dimension.value)
    return
  }
  if (dimension.kind === 'distance') {
    if (dimension.value < 0) throw new Error('distance cannot be negative')
    separate(entities, dimension.a, dimension.b, dimension.value)
    return
  }
  setAngle(entities, dimension.entityId, (dimension.value * Math.PI) / 180)
}

function applyConstraint(entities: SketchEntity[], constraint: SketchConstraint): void {
  if (constraint.kind === 'horizontal' || constraint.kind === 'vertical') {
    const line = expectLine(entities, constraint.entityId, constraint.kind)
    if (constraint.kind === 'horizontal') {
      const y = (line.y1 + line.y2) / 2
      line.y1 = y
      line.y2 = y
    } else {
      const x = (line.x1 + line.x2) / 2
      line.x1 = x
      line.x2 = x
    }
    return
  }
  if (constraint.kind === 'coincident') {
    const target = readPoint(entities, constraint.a)
    writePoint(entities, constraint.b, target)
    return
  }
  if (constraint.kind === 'equal') {
    applyEqual(entities, constraint.a, constraint.b)
    return
  }
  if (constraint.kind === 'distance') {
    assertFinite(constraint.value, 'distance')
    if (constraint.value < 0) throw new Error('distance cannot be negative')
    separate(entities, constraint.a, constraint.b, constraint.value)
    return
  }
  assertFinite(constraint.value, 'radius')
  if (constraint.value < 0) throw new Error('radius cannot be negative')
  setRadius(entities, constraint.entityId, constraint.value)
}

function applyEqual(entities: SketchEntity[], aId: string, bId: string): void {
  const a = findEntity(entities, aId)
  const b = findEntity(entities, bId)
  if (a.kind === 'line' && b.kind === 'line') {
    setLineLength(b, lineLength(a))
    return
  }
  if ((a.kind === 'circle' || a.kind === 'arc') && (b.kind === 'circle' || b.kind === 'arc')) {
    b.radius = a.radius
    return
  }
  if (a.kind === 'rect' && b.kind === 'rect') {
    b.width = a.width
    b.height = a.height
    return
  }
  throw new Error(`Cannot apply equal to ${a.kind} and ${b.kind}`)
}

function setAngle(entities: SketchEntity[], entityId: string, radians: number): void {
  const entity = findEntity(entities, entityId)
  if (entity.kind === 'line') {
    const length = lineLength(entity) || 0
    entity.x2 = entity.x1 + length * Math.cos(radians)
    entity.y2 = entity.y1 + length * Math.sin(radians)
    return
  }
  if (entity.kind === 'arc') {
    entity.endAngle = entity.startAngle + radians
    return
  }
  throw new Error(`angle needs a line or an arc, got ${entity.kind}`)
}

function setRadius(entities: SketchEntity[], entityId: string, radius: number): void {
  const entity = findEntity(entities, entityId)
  if (entity.kind !== 'circle' && entity.kind !== 'arc') {
    throw new Error(`radius needs a circle or an arc, got ${entity.kind}`)
  }
  entity.radius = radius
}

function separate(entities: SketchEntity[], a: PointRef, b: PointRef, distance: number): void {
  const origin = readPoint(entities, a)
  const moving = readPoint(entities, b)
  writePoint(entities, b, pointAtDistance(origin, moving, distance))
}

function pointAtDistance(origin: Vec, moving: Vec, distance: number): Vec {
  let dx = moving.x - origin.x
  let dy = moving.y - origin.y
  const length = Math.hypot(dx, dy)
  if (length < EPS) {
    dx = 1
    dy = 0
  } else {
    dx /= length
    dy /= length
  }
  return { x: origin.x + dx * distance, y: origin.y + dy * distance }
}

function readPoint(entities: SketchEntity[], ref: PointRef): Vec {
  const entity = findEntity(entities, ref.entityId)
  if (entity.kind === 'point') return { x: entity.x, y: entity.y }
  if (entity.kind === 'line') {
    if (ref.slot === 'end') return { x: entity.x2, y: entity.y2 }
    if (ref.slot === 'center') {
      return { x: (entity.x1 + entity.x2) / 2, y: (entity.y1 + entity.y2) / 2 }
    }
    return { x: entity.x1, y: entity.y1 }
  }
  if (entity.kind === 'rect') {
    if (ref.slot === 'end') return { x: entity.x + entity.width, y: entity.y + entity.height }
    if (ref.slot === 'center') {
      return { x: entity.x + entity.width / 2, y: entity.y + entity.height / 2 }
    }
    return { x: entity.x, y: entity.y }
  }
  if (entity.kind === 'circle') return { x: entity.cx, y: entity.cy }
  if (ref.slot === 'start') return arcPoint(entity, entity.startAngle)
  if (ref.slot === 'end') return arcPoint(entity, entity.endAngle)
  return { x: entity.cx, y: entity.cy }
}

function writePoint(entities: SketchEntity[], ref: PointRef, point: Vec): void {
  const entity = findEntity(entities, ref.entityId)
  if (entity.kind === 'point') {
    entity.x = point.x
    entity.y = point.y
    return
  }
  if (entity.kind === 'line') {
    if (ref.slot === 'end') {
      entity.x2 = point.x
      entity.y2 = point.y
      return
    }
    if (ref.slot === 'center') {
      translate(
        entity,
        point.x - (entity.x1 + entity.x2) / 2,
        point.y - (entity.y1 + entity.y2) / 2,
      )
      return
    }
    entity.x1 = point.x
    entity.y1 = point.y
    return
  }
  if (entity.kind === 'rect') {
    if (ref.slot === 'end') {
      entity.width = point.x - entity.x
      entity.height = point.y - entity.y
      return
    }
    if (ref.slot === 'center') {
      entity.x += point.x - (entity.x + entity.width / 2)
      entity.y += point.y - (entity.y + entity.height / 2)
      return
    }
    entity.x = point.x
    entity.y = point.y
    return
  }
  if (entity.kind === 'circle') {
    entity.cx = point.x
    entity.cy = point.y
    return
  }
  if (ref.slot === 'start' || ref.slot === 'end') {
    const current = arcPoint(entity, ref.slot === 'start' ? entity.startAngle : entity.endAngle)
    entity.cx += point.x - current.x
    entity.cy += point.y - current.y
    return
  }
  entity.cx = point.x
  entity.cy = point.y
}

function translate(line: SketchLine, dx: number, dy: number): void {
  line.x1 += dx
  line.y1 += dy
  line.x2 += dx
  line.y2 += dy
}

function arcPoint(arc: SketchArc, angle: number): Vec {
  return { x: arc.cx + arc.radius * Math.cos(angle), y: arc.cy + arc.radius * Math.sin(angle) }
}

function lineLength(line: SketchLine): number {
  return Math.hypot(line.x2 - line.x1, line.y2 - line.y1)
}

function setLineLength(line: SketchLine, length: number): void {
  let dx = line.x2 - line.x1
  let dy = line.y2 - line.y1
  const current = Math.hypot(dx, dy)
  if (current < EPS) {
    dx = 1
    dy = 0
  } else {
    dx /= current
    dy /= current
  }
  line.x2 = line.x1 + dx * length
  line.y2 = line.y1 + dy * length
}

function expectLine(entities: SketchEntity[], id: string, label: string): SketchLine {
  const entity = findEntity(entities, id)
  if (entity.kind !== 'line') throw new Error(`${label} needs a line, got ${entity.kind}`)
  return entity
}

function expectRect(entities: SketchEntity[], id: string, label: string): SketchRect {
  const entity = findEntity(entities, id)
  if (entity.kind !== 'rect') throw new Error(`${label} needs a rect, got ${entity.kind}`)
  return entity
}

function findEntity(entities: SketchEntity[], id: string): SketchEntity {
  const entity = entities.find((item) => item.id === id)
  if (!entity) throw new Error(`No sketch entity ${id}`)
  return entity
}

function assertFinite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`)
}

function cloneEntity(entity: SketchEntity): SketchEntity {
  if (entity.kind === 'point') return { ...entity } satisfies SketchPoint
  if (entity.kind === 'line') return { ...entity } satisfies SketchLine
  if (entity.kind === 'rect') return { ...entity } satisfies SketchRect
  if (entity.kind === 'circle') return { ...entity } satisfies SketchCircle
  return { ...entity } satisfies SketchArc
}

function fingerprint(entities: SketchEntity[]): number[] {
  const values: number[] = []
  for (const entity of entities) {
    if (entity.kind === 'point') values.push(entity.x, entity.y)
    else if (entity.kind === 'line') values.push(entity.x1, entity.y1, entity.x2, entity.y2)
    else if (entity.kind === 'rect') values.push(entity.x, entity.y, entity.width, entity.height)
    else if (entity.kind === 'circle') values.push(entity.cx, entity.cy, entity.radius)
    else values.push(entity.cx, entity.cy, entity.radius, entity.startAngle, entity.endAngle)
  }
  return values
}
