/**
 * Clickable datum planes.
 *
 * An empty scene used to be a bare origin gizmo: the only way to start a sketch
 * was to guess that pressing Sketch would land on XY. These planes make the
 * choice visible and direct. Each one is a flat quad in the plane it names,
 * translucent so it reads as a surface rather than a solid.
 */

export type DatumPlane = 'XY' | 'YZ' | 'ZX'

export interface PlanePlacement {
  id: DatumPlane
  label: string
  /** Corner of the quad, centred on the origin. */
  center: [number, number, number]
  /** The two in-plane axes, scaled to the half extent. */
  u: [number, number, number]
  v: [number, number, number]
  /** Outward normal, used to place the label. */
  normal: [number, number, number]
}

export const DATUM_PLANES: readonly DatumPlane[] = ['XY', 'YZ', 'ZX']

/** Half-width of each plane quad, in millimetres. */
export const PLANE_HALF_EXTENT = 26

const AXES: Record<DatumPlane, { u: [number, number, number]; v: [number, number, number]; n: [number, number, number] }> = {
  // XY is the floor, so its normal points up in +Z.
  XY: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  // YZ is the right wall.
  YZ: { u: [0, 1, 0], v: [0, 0, 1], n: [1, 0, 0] },
  // ZX is the front wall. u runs along +Z so the frame stays right-handed.
  ZX: { u: [0, 0, 1], v: [1, 0, 0], n: [0, 1, 0] },
}

export const PLANE_LABELS: Record<DatumPlane, string> = {
  XY: 'XY',
  YZ: 'YZ',
  ZX: 'ZX',
}

/**
 * Where to draw each plane.
 *
 * The quads are kept small on purpose: three 120mm planes meeting at the origin
 * read as one confusing wedge. At 26mm half extent they sit as three distinct
 * corner tiles, which is enough to aim at without swallowing the view.
 */
export function planePlacements(half: number = PLANE_HALF_EXTENT): PlanePlacement[] {
  return DATUM_PLANES.map((id) => {
    const axes = AXES[id]
    return {
      id,
      label: PLANE_LABELS[id],
      center: [0, 0, 0],
      u: [axes.u[0] * half, axes.u[1] * half, axes.u[2] * half],
      v: [axes.v[0] * half, axes.v[1] * half, axes.v[2] * half],
      normal: axes.n,
    }
  })
}

/**
 * The four corners of a plane quad, in draw order.
 * Two triangles would also work, but a loop makes the outline obvious.
 */
export function planeCorners(place: PlanePlacement): Array<[number, number, number]> {
  const [cx, cy, cz] = place.center
  const [ux, uy, uz] = place.u
  const [vx, vy, vz] = place.v
  return [
    [cx - ux - vx, cy - uy - vy, cz - uz - vz],
    [cx + ux - vx, cy + uy - vy, cz + uz - vz],
    [cx + ux + vx, cy + uy + vy, cz + uz + vz],
    [cx - ux + vx, cy - uy + vy, cz - uz + vz],
  ]
}

/** Centre of the quad, offset slightly along the normal so the label clears it. */
export function planeLabelAt(
  place: PlanePlacement,
  offset = 4,
): [number, number, number] {
  return [
    place.center[0] + place.normal[0] * offset,
    place.center[1] + place.normal[1] * offset,
    place.center[2] + place.normal[2] * offset,
  ]
}

/**
 * Which plane names are worth showing.
 *
 * Before anything is drawn all three are useful. Once a solid exists the planes
 * just add clutter, so the host hides them. A sketch in progress always shows
 * the plane it is on.
 */
export function visiblePlanes(hasSolids: boolean, sketching: boolean): DatumPlane[] {
  if (sketching) return []
  return hasSolids ? [] : [...DATUM_PLANES]
}
