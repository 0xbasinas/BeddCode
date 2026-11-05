import type { SketchToolName } from './project.ts'
import type { SketchArc, SketchCircle, SketchEntity, SketchLine, SketchRect } from './types.ts'

const EPS = 1e-6

/**
 * Reads one length or a width and height.
 * Accepts `12`, `12.5`, `40, 25`, `40 x 25`, `40×25`, `R 4`, and `R4`.
 */
export function parseDimensionText(text: string): number[] | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  const radius = /^r\s*(.*)$/i.exec(trimmed)
  const body = (radius ? (radius[1] ?? '') : trimmed).trim()
  if (!body) return null
  const parts = body
    .split(/[x×,]/i)
    .flatMap((part) => part.trim().split(/\s+/))
    .filter((part) => part.length > 0)
  if (parts.length === 0 || parts.length > 2) return null
  const values: number[] = []
  for (const part of parts) {
    if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(part)) return null
    const value = Number(part)
    if (!Number.isFinite(value)) return null
    values.push(value)
  }
  return values
}

/**
 * Turns a typed size into the next sketch entity.
 * A line advances the chain. A rectangle or circle finishes.
 * Non-positive sizes and a line or circle with two numbers are refused.
 */
export function commitLiveDimension(
  tool: SketchToolName,
  placed: readonly (readonly [number, number])[],
  cursor: readonly [number, number] | null,
  text: string,
  id: string,
): { placed: Array<[number, number]>; entity: SketchEntity | null } | null {
  const values = positive(parseDimensionText(text))
  if (!values) return null
  const origin = placed[0]
  if (!origin) return null
  if (tool === 'line') {
    const length = values[0]
    if (length === undefined || values.length !== 1) return null
    const end = pointAtLength(origin, cursor, length)
    return {
      placed: [end],
      entity: { id, kind: 'line', x1: origin[0], y1: origin[1], x2: end[0], y2: end[1] },
    }
  }
  if (tool === 'rectangle') {
    const width = values[0]
    if (width === undefined) return null
    const cursorHeight = cursor ? Math.abs(cursor[1] - origin[1]) : 0
    const height = values[1] ?? (cursorHeight > EPS ? cursorHeight : width)
    if (!(height > EPS)) return null
    const signX = cursor && cursor[0] < origin[0] ? -1 : 1
    const signY = cursor && cursor[1] < origin[1] ? -1 : 1
    return {
      placed: [],
      entity: {
        id,
        kind: 'rect',
        x: signX > 0 ? origin[0] : origin[0] - width,
        y: signY > 0 ? origin[1] : origin[1] - height,
        width,
        height,
      },
    }
  }
  if (tool === 'circle') {
    const radius = values[0]
    if (radius === undefined || values.length !== 1) return null
    return {
      placed: [],
      entity: { id, kind: 'circle', cx: origin[0], cy: origin[1], radius },
    }
  }
  return null
}

/** Rewrites one entity from a dimension label. Returns null when the text does not apply. */
export function applyDimensionToEntity(entity: SketchEntity, text: string): SketchEntity | null {
  const values = positive(parseDimensionText(text))
  if (!values) return null
  if (entity.kind === 'line') return resizeLine(entity, values)
  if (entity.kind === 'rect') return resizeRect(entity, values)
  if (entity.kind === 'circle') return resizeCircle(entity, values)
  if (entity.kind === 'arc') return resizeArc(entity, values)
  return null
}

function positive(values: number[] | null): number[] | null {
  if (!values || values.length === 0) return null
  if (values.some((value) => !(value > 0))) return null
  return values
}

function pointAtLength(
  origin: readonly [number, number],
  cursor: readonly [number, number] | null,
  length: number,
): [number, number] {
  const dx = cursor ? cursor[0] - origin[0] : 1
  const dy = cursor ? cursor[1] - origin[1] : 0
  const span = Math.hypot(dx, dy)
  if (span <= EPS) return [origin[0] + length, origin[1]]
  return [origin[0] + (dx / span) * length, origin[1] + (dy / span) * length]
}

function resizeLine(entity: SketchLine, values: number[]): SketchLine | null {
  const length = values[0]
  if (length === undefined || values.length !== 1) return null
  const dx = entity.x2 - entity.x1
  const dy = entity.y2 - entity.y1
  const span = Math.hypot(dx, dy)
  if (span <= EPS) return { ...entity, x2: entity.x1 + length, y2: entity.y1 }
  const scale = length / span
  return { ...entity, x2: entity.x1 + dx * scale, y2: entity.y1 + dy * scale }
}

function resizeRect(entity: SketchRect, values: number[]): SketchRect | null {
  const width = values[0]
  if (width === undefined) return null
  const height = values[1] ?? entity.height
  if (!(height > EPS)) return null
  return { ...entity, width, height }
}

function resizeCircle(entity: SketchCircle, values: number[]): SketchCircle | null {
  const radius = values[0]
  if (radius === undefined || values.length !== 1) return null
  return { ...entity, radius }
}

function resizeArc(entity: SketchArc, values: number[]): SketchArc | null {
  const radius = values[0]
  if (radius === undefined || values.length !== 1) return null
  return { ...entity, radius }
}
