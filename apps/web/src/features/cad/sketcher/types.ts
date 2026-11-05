/** Sketch geometry, driving dimensions, and geometric constraints. */

export type SketchPlane = 'XY' | 'XZ' | 'YZ'

export type PointSlot = 'start' | 'end' | 'center' | 'origin'

/** A point on an entity. `slot` picks which point when the entity has several. */
export interface PointRef {
  entityId: string
  slot: PointSlot
}

export interface SketchPoint {
  id: string
  kind: 'point'
  x: number
  y: number
}

export interface SketchLine {
  id: string
  kind: 'line'
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Axis-aligned rectangle. The origin is the min corner when width and height are positive. */
export interface SketchRect {
  id: string
  kind: 'rect'
  x: number
  y: number
  width: number
  height: number
}

export interface SketchCircle {
  id: string
  kind: 'circle'
  cx: number
  cy: number
  radius: number
}

/** `startAngle` and `endAngle` are radians, measured from +x. */
export interface SketchArc {
  id: string
  kind: 'arc'
  cx: number
  cy: number
  radius: number
  startAngle: number
  endAngle: number
}

export type SketchEntity = SketchPoint | SketchLine | SketchRect | SketchCircle | SketchArc

export type SketchConstraint =
  | { id: string; kind: 'horizontal'; entityId: string }
  | { id: string; kind: 'vertical'; entityId: string }
  | { id: string; kind: 'coincident'; a: PointRef; b: PointRef }
  | { id: string; kind: 'equal'; a: string; b: string }
  | { id: string; kind: 'distance'; a: PointRef; b: PointRef; value: number }
  | { id: string; kind: 'radius'; entityId: string; value: number }

/** Driving dimensions. Angle values are degrees. */
export type SketchDimension =
  | { id: string; kind: 'width'; entityId: string; value: number }
  | { id: string; kind: 'height'; entityId: string; value: number }
  | { id: string; kind: 'distance'; a: PointRef; b: PointRef; value: number }
  | { id: string; kind: 'radius'; entityId: string; value: number }
  | { id: string; kind: 'angle'; entityId: string; value: number }

export interface Sketch {
  id: string
  name: string
  plane: SketchPlane
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  dimensions: SketchDimension[]
}

export type SketchEntityDraft =
  | Omit<SketchPoint, 'id'>
  | Omit<SketchLine, 'id'>
  | Omit<SketchRect, 'id'>
  | Omit<SketchCircle, 'id'>
  | Omit<SketchArc, 'id'>

export type SketchConstraintDraft =
  | { kind: 'horizontal'; entityId: string }
  | { kind: 'vertical'; entityId: string }
  | { kind: 'coincident'; a: PointRef; b: PointRef }
  | { kind: 'equal'; a: string; b: string }
  | { kind: 'distance'; a: PointRef; b: PointRef; value: number }
  | { kind: 'radius'; entityId: string; value: number }

export type SketchDimensionDraft =
  | { kind: 'width'; entityId: string; value: number }
  | { kind: 'height'; entityId: string; value: number }
  | { kind: 'distance'; a: PointRef; b: PointRef; value: number }
  | { kind: 'radius'; entityId: string; value: number }
  | { kind: 'angle'; entityId: string; value: number }
