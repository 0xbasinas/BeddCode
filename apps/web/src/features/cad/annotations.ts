/**
 * Measurements that stay on screen.
 *
 * A single transient readout disappears as soon as the next pick lands, so a
 * part with three holes cannot be inspected. These annotations are kept in a
 * list, each tied to the feature it measures, and disappear when that feature
 * is deleted.
 */

export interface Annotation {
  id: string
  /** Feature being measured. The annotation dies with it. */
  featureId: string
  /** Short heading, usually the feature name. */
  title: string
  /** Formatted value lines. */
  lines: readonly string[]
  /** World points, when the annotation marks a distance. */
  a?: [number, number, number]
  b?: [number, number, number]
}

/** Add an annotation, replacing any earlier one for the same feature. */
export function addAnnotation(
  list: readonly Annotation[],
  next: Annotation,
): readonly Annotation[] {
  const without = list.filter((item) => item.featureId !== next.featureId)
  return [...without, next]
}

export function removeAnnotation(
  list: readonly Annotation[],
  id: string,
): readonly Annotation[] {
  return list.filter((item) => item.id !== id)
}

/** Drop annotations whose feature is gone, so a delete cannot leave orphans. */
export function pruneAnnotations(
  list: readonly Annotation[],
  liveFeatureIds: ReadonlySet<string>,
): readonly Annotation[] {
  const kept = list.filter((item) => liveFeatureIds.has(item.featureId))
  return kept.length === list.length ? (list as readonly Annotation[]) : kept
}

/** The nearest annotation to a screen point, for click-to-delete. */
export function hitAnnotation(
  list: readonly Annotation[],
  point: { x: number; y: number },
  placed: Readonly<Record<string, { x: number; y: number }>>,
  radius: number,
): Annotation | null {
  let best: Annotation | null = null
  let bestDist = radius
  for (const item of list) {
    const at = placed[item.id]
    if (!at) continue
    const dist = Math.hypot(at.x - point.x, at.y - point.y)
    if (dist <= bestDist) {
      best = item
      bestDist = dist
    }
  }
  return best
}
