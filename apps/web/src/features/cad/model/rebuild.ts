import type { CadDocument, FeatureKind, FeatureNode, ParamValue } from './CadDocument.ts'

/** One kernel call, in rebuild order. Suppressed features are not included. */
export interface RebuildOp {
  featureId: string
  name: string
  kind: FeatureKind
  params: Record<string, ParamValue>
}

/**
 * Kernel the rebuild applies ops to. Tests pass a mock that records calls.
 * A real kernel (replicad / OCCT) implements the same methods.
 */
export interface RebuildKernel {
  box(op: RebuildOp): void
  cylinder(op: RebuildOp): void
  sphere(op: RebuildOp): void
  extrude(op: RebuildOp): void
  revolve(op: RebuildOp): void
  fillet(op: RebuildOp): void
  chamfer(op: RebuildOp): void
  union(op: RebuildOp): void
  cut(op: RebuildOp): void
  intersect(op: RebuildOp): void
  sketch?(op: RebuildOp): void
}

/** Features in tree order, skipping suppressed ones. */
export function rebuildPlan(doc: CadDocument): RebuildOp[] {
  const ops: RebuildOp[] = []
  for (const feature of doc.features) {
    if (feature.suppressed) continue
    if (feature.kind === 'sketch') continue
    ops.push({
      featureId: feature.id,
      name: feature.name,
      kind: feature.kind,
      params: feature.params,
    })
  }
  return ops
}

/** Applies a plan. The kernel is called once per op, in order. */
export function applyRebuild(plan: readonly RebuildOp[], kernel: RebuildKernel): void {
  for (const op of plan) {
    const fn = kernel[op.kind as Exclude<FeatureKind, 'sketch'>]
    if (typeof fn === 'function') fn.call(kernel, op)
  }
}

/** Plans `doc` and applies it. */
export function rebuild(doc: CadDocument, kernel: RebuildKernel): RebuildOp[] {
  const plan = rebuildPlan(doc)
  applyRebuild(plan, kernel)
  return plan
}

export type { FeatureNode }
