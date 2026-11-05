import type { Sketch } from '../sketcher/types.ts'

export type CadUnits = 'mm' | 'cm' | 'm' | 'in'

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

export interface ExtrudeParams {
  sketchId: string
  distance: number
}

export interface RevolveParams {
  sketchId: string
  /** Sweep in degrees. */
  angle: number
}

export interface FilletParams {
  radius: number
  featureId?: string
}

export interface ChamferParams {
  distance: number
  featureId?: string
}

/** Boolean of `toolId` against `targetId`. */
export interface BooleanParams {
  targetId: string
  toolId: string
}

interface FeatureBase {
  id: string
  name: string
  suppressed: boolean
}

export type FeatureNode =
  | (FeatureBase & { kind: 'box'; params: BoxParams })
  | (FeatureBase & { kind: 'cylinder'; params: CylinderParams })
  | (FeatureBase & { kind: 'sphere'; params: SphereParams })
  | (FeatureBase & { kind: 'extrude'; params: ExtrudeParams })
  | (FeatureBase & { kind: 'revolve'; params: RevolveParams })
  | (FeatureBase & { kind: 'fillet'; params: FilletParams })
  | (FeatureBase & { kind: 'chamfer'; params: ChamferParams })
  | (FeatureBase & { kind: 'union'; params: BooleanParams })
  | (FeatureBase & { kind: 'cut'; params: BooleanParams })
  | (FeatureBase & { kind: 'intersect'; params: BooleanParams })

export type FeatureKind = FeatureNode['kind']

export type FeatureParamsOf<K extends FeatureKind> = Extract<FeatureNode, { kind: K }>['params']

/** A feature before it is given an id. `id` and `name` may be filled in by the tree. */
export type FeatureDraft = {
  [K in FeatureKind]: {
    id?: string
    name?: string
    suppressed?: boolean
    kind: K
    params: FeatureParamsOf<K>
  }
}[FeatureKind]

/**
 * JSON document for one CAD part. `features` rebuild in array order.
 * `historyIndex` is the undo cursor (see undo.ts). `params` holds named numbers
 * shared by the part, such as a thickness used by more than one feature.
 */
export interface CadDocument {
  id: string
  name: string
  rev: number
  updatedAt: number
  units: CadUnits
  features: FeatureNode[]
  sketches: Sketch[]
  params: Record<string, number>
  historyIndex: number
}

export function emptyCadDocument(partial: Partial<CadDocument> = {}): CadDocument {
  return {
    id: partial.id ?? 'part',
    name: partial.name ?? 'Part',
    rev: partial.rev ?? 1,
    updatedAt: partial.updatedAt ?? 0,
    units: partial.units ?? 'mm',
    features: partial.features ?? [],
    sketches: partial.sketches ?? [],
    params: partial.params ?? {},
    historyIndex: partial.historyIndex ?? 0,
  }
}
