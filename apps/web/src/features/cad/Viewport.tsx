import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  AmbientLight,
  AxesHelper,
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Float32BufferAttribute,
  Fog,
  GridHelper,
  Group,
  Line,
  LineBasicMaterial,
  LineSegments,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { Line2 } from 'three/addons/lines/Line2.js'
import { LineGeometry } from 'three/addons/lines/LineGeometry.js'
import { LineMaterial } from 'three/addons/lines/LineMaterial.js'
import { acceleratedRaycast, computeBoundsTree, disposeBoundsTree } from 'three-mesh-bvh'
import type { EdgeGroup, FaceGroup, MeshBuffers } from './solids.ts'
import { faceAt, faceTriangle } from './solids.ts'
import {
  boxSelect,
  mergeSelection,
  rankedHits,
  sameItem,
  segmentDistancePx,
  selectionKey,
  keepKind,
  toggleSelection,
  type CenterItem,
  type HitCandidate,
  type PickKind,
  type SelectionItem,
} from './selection.ts'
import { SketchOverlay, type OverlayLabel } from './SketchOverlay.tsx'
import { applyDimensionToEntity, commitLiveDimension } from './sketcher/dimension.ts'
import {
  advanceSketch,
  DEFAULT_POLYGON_SIDES,
  asWorkPlane,
  CAMERA_UP,
  DEFAULT_CAMERA_POSITION,
  edgePickThreshold,
  entityAnnotation,
  entityPolyline,
  formatLength,
  gridRotation,
  planeKey,
  previewAnnotation,
  previewPolyline,
  projectRayToPlane,
  toWorld,
  viewDirection,
  worldDistance,
  type PlaneArg,
  type SketchPlaneName,
  type SketchToolName,
} from './sketcher/project.ts'
import {
  DEFAULT_SNAP_SETTINGS,
  gridStepForShift,
  resolveSnap,
  sketchSnapTolerance,
  snapCaption,
  type SnapKind,
  type SnapSettings,
} from './sketcher/snap.ts'
import type { SketchEntity } from './sketcher/types.ts'
import { ViewCube, type ViewName } from './ViewCube.tsx'
import { planeCorners, planePlacements, visiblePlanes, type DatumPlane } from './planes.ts'

export type { MeshBuffers } from './solids.ts'
export type { ViewName } from './ViewCube.tsx'
export type { OverlayLabel } from './SketchOverlay.tsx'
export type { SketchPlaneName, SketchToolName }

const NO_ENTITIES: SketchEntity[] = []

BufferGeometry.prototype.computeBoundsTree = computeBoundsTree
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree
Mesh.prototype.raycast = acceleratedRaycast

/**
 * Optional props CadPane can pass later. Defaults keep the current pane.
 * - loading: `.cad-loading` overlay while the geometry kernel starts
 * - pickMode: the selection filter, `'face'` (default), `'edge'`, or `'vertex'`.
 *   Shift-click adds or removes from the selection; Ctrl/Cmd + drag box-selects.
 * - sketchMode, sketchTool (`line` | `rectangle` | `circle` | `arc`), plane
 *   (named datum or a face frame), sketchSnap (millimetres; Shift flips 1 and 5),
 *   entities (sketcher entities, not the document params bag), onSketchChange, onSketchFinish
 * - measure: `{ a, b, label }` draws a distance between two world points
 * Delete and Undo belong to the parent. Escape drops the open sketch segment.
 * Enter finishes the sketch, or commits a typed length when the dimension field has text.
 */
export interface MeasureVisual {
  a?: [number, number, number]
  b?: [number, number, number]
  /** Replaces the computed millimetre distance. */
  label?: string
}

/** A face, edge, or vertex the raycaster hit. `pickMode` is the active selection filter. */
export interface PickHit {
  kind: PickKind
  featureId: string
  /** Triangle index, or the edge segment's first vertex when `kind` is `edge`. */
  index: number
  faceId?: number
  edgeId?: number
  vertexId?: number
  point?: [number, number, number]
}

export interface ViewportHandle {
  fit(): void
  /** Commit the open sketch and report its entities to the host. */
  finishSketch(): void
  /** Look straight down the active sketch plane. */
  lookAtSketch(): void
  /** Return to the perspective modelling view, framed on the part. */
  lookAtPart(): void
  clearSelection(): void
  /** PNG data URL of the WebGL canvas. */
  screenshot(): string
  setView(view: ViewName): void
}

const SOLID = 0x8a9096
const SOLID_SELECTED = 0xb9c0c7
// Edges read as crisp outlines rather than vanishing into the face colour.
const EDGE = 0x2b3036
const EDGE_HOVER = 0xb0b0b0
const SKETCH = 0x8a8a8a
const SKETCH_PREVIEW = 0xb4b4b4
const MEASURE = 0x9a9a9a
const PLANE_FACE = 0x4a6580
const PLANE_FACE_HOVER = 0x7fa8d4
const PLANE_EDGE = 0x6f8fae
const HOVER = 0xcfcfcf
const SELECTED = 0xe0e0e0

interface DraftAnchor {
  x: number
  y: number
  placeholder: string
  label: string
}

interface SceneHooks {
  onPick(hit: PickHit | null): void
  onSelectionChange(hits: PickHit[]): void
  onSketchChange(entities: SketchEntity[]): void
  /** Points placed for the current sketch tool, so the host can advance its steps. */
  onSketchPlaced(placed: number): void
  /** A datum plane was clicked, so the host can start a sketch on it. */
  onPlanePick(plane: DatumPlane): void
  onSketchFinish(entities: SketchEntity[]): void
  onLabels(labels: OverlayLabel[]): void
  onDraft(draft: DraftAnchor | null): void
}

interface SceneSession {
  sketchMode: boolean
  sketchTool: SketchToolName
  plane: PlaneArg
  snap: number
  /** Side count for the polygon tool. */
  polygonSides: number
  /** Master object-snap switch and per-kind switches. */
  snapEnabled: boolean
  snapSettings: SnapSettings
  pickMode: PickKind
  entities: SketchEntity[]
  measure: MeasureVisual | null
  placed: Array<[number, number]>
  /** True while the active sketch tool keeps chaining, as a polyline does. */
  chaining: boolean
  cursor: [number, number] | null
  snapKind: SnapKind | null
}

interface SceneApi {
  resize(): void
  clearSelection(): void
  setMeshes(meshes: MeshBuffers[], selectedId: string | null): void
  setInteraction(next: Omit<SceneSession, 'placed' | 'chaining' | 'cursor' | 'snapKind'>): void
  cancelSketch(): void
  finishSketch(): void
  applyDraftDimension(text: string): boolean
  applyEntityDimension(id: string, text: string): boolean
  fit(): void
  lookAtSketch(): void
  lookAtPart(): void
  screenshot(): string
  setView(view: ViewName): void
  dispose(): void
}

function pointTuple(point: Vector3): [number, number, number] {
  return [point.x, point.y, point.z]
}

function disposeObject(object: Object3D) {
  const geometry = (object as Mesh).geometry as BufferGeometry | undefined
  if (geometry) {
    if (geometry.boundsTree) geometry.disposeBoundsTree()
    geometry.dispose()
  }
  const material = (object as Mesh).material as Mesh['material'] | undefined
  if (Array.isArray(material)) for (const item of material) item.dispose()
  else material?.dispose()
}

function clearGroup(group: Group) {
  for (const child of [...group.children]) {
    disposeObject(child)
    group.remove(child)
  }
}

function mountScene(host: HTMLElement, hooks: SceneHooks): SceneApi {
  const scene = new Scene()
  const camera = new PerspectiveCamera(45, 1, 0.1, 5000)
  // Z-up. Set this before OrbitControls; the control copies it as the orbit axis.
  camera.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2])
  camera.position.set(
    DEFAULT_CAMERA_POSITION[0],
    DEFAULT_CAMERA_POSITION[1],
    DEFAULT_CAMERA_POSITION[2],
  )
  camera.lookAt(0, 0, 0)

  const renderer = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.setClearColor(new Color(0x000000), 0)
  host.appendChild(renderer.domElement)

  const controls = new OrbitControls(camera, renderer.domElement)
  controls.target.set(0, 0, 0)
  // Damping makes orbit and pan coast to a stop instead of snapping.
  controls.enableDamping = true
  controls.dampingFactor = 0.09
  // Zoom toward the pointer, so the thing under the cursor stays under it.
  controls.zoomToCursor = true
  // Pan in the screen plane. Without this, panning drifts along the ground and
  // the model slides away when the camera is looking from the side.
  controls.screenSpacePanning = true
  controls.minDistance = 0.5
  controls.maxDistance = 4000
  // Keep the camera off the poles, where the orbit axis flips and the view spins.
  controls.minPolarAngle = 0.001
  controls.maxPolarAngle = Math.PI - 0.001
  controls.update()

  // A three-point rig. One key light alone leaves faces at the same flat value,
  // so a cube reads as a silhouette. The fill and rim give each face its own value.
  scene.add(new AmbientLight(0xffffff, 0.33))
  const key = new DirectionalLight(0xffffff, 1.7)
  key.position.set(46, -60, 88)
  scene.add(key)
  const fill = new DirectionalLight(0xdde6f2, 0.5)
  fill.position.set(-70, -30, 30)
  scene.add(fill)
  const rim = new DirectionalLight(0xffffff, 0.4)
  rim.position.set(10, 80, -40)
  scene.add(rim)
  // Very light fog so distant grid lines fade instead of ending on a hard edge.
  scene.fog = new Fog(0x16181b, 190, 520)
  const ground = new GridHelper(400, 80, 0x3a3f45, 0x24282c)
  const floorTurn = gridRotation('XY')
  ground.rotation.set(floorTurn[0], floorTurn[1], floorTurn[2])
  ;(ground.material as Material).transparent = true
  ;(ground.material as Material).opacity = 0.55
  scene.add(ground)
  // The axes mark the origin; a small helper does that without shouting.
  scene.add(new AxesHelper(12))

  const parts = new Group()
  const hoverGroup = new Group()
  const selectGroup = new Group()
  const sketchGroup = new Group()
  const previewGroup = new Group()
  const measureGroup = new Group()
  const planeGroup = new Group()
  scene.add(planeGroup)
  scene.add(parts)
  scene.add(selectGroup)
  scene.add(hoverGroup)
  scene.add(sketchGroup)
  scene.add(previewGroup)
  scene.add(measureGroup)

  const raycaster = new Raycaster()
  raycaster.params.Line.threshold = edgePickThreshold(camera.position.length())
  raycaster.firstHitOnly = true
  const pointer = new Vector2()
  const resolution = new Vector2(1, 1)
  const projected = new Vector3()
  const forward = new Vector3()
  const lineMaterials: LineMaterial[] = []
  let sketchGrid: GridHelper | null = null
  let hoverKey = ''
  let sketchSeq = 1
  let downX = 0
  let downY = 0
  let down = false
  let lastPointer: PointerEvent | null = null
  let cycleHits: Found[] = []
  let cycleIndex = 0
  let selection: SelectionItem[] = []
  /** Non-zero while a view change is tweening the camera. */
  let viewAnim = 0
  let boxing = false
  let boxFrame: HTMLDivElement | null = null
  let boxFrom = { x: 0, y: 0 }

  type Found = HitCandidate & { object: Object3D; index: number; point: Vector3 }

  const session: SceneSession = {
    sketchMode: false,
    sketchTool: 'line',
    plane: 'XY',
    snap: 1,
    polygonSides: DEFAULT_POLYGON_SIDES,
    snapEnabled: true,
    snapSettings: DEFAULT_SNAP_SETTINGS,
    pickMode: 'face',
    entities: [],
    measure: null,
    placed: [],
    chaining: false,
    cursor: null,
    snapKind: null,
  }

  const featureIdOf = (object: Object3D) =>
    typeof object.userData.featureId === 'string' ? object.userData.featureId : ''

  const resize = () => {
    const width = host.clientWidth
    const height = host.clientHeight
    if (width === 0 || height === 0) return
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
    resolution.set(renderer.domElement.width, renderer.domElement.height)
    for (const material of lineMaterials) material.resolution.copy(resolution)
  }

  const trackMaterial = (material: LineMaterial) => {
    material.resolution.copy(resolution)
    lineMaterials.push(material)
  }

  const addPolyline = (group: Group, points: Array<[number, number, number]>, color: number) => {
    if (points.length < 2) return
    const flat: number[] = []
    for (const point of points) flat.push(point[0], point[1], point[2])
    const geometry = new LineGeometry()
    geometry.setPositions(flat)
    const material = new LineMaterial({
      color,
      linewidth: 2,
      worldUnits: false,
      transparent: true,
      opacity: 0.95,
    })
    trackMaterial(material)
    const line = new Line2(geometry, material)
    line.computeLineDistances()
    group.add(line)
  }

  const gridBasis = new Matrix4()
  const gridX = new Vector3()
  const gridY = new Vector3()
  const gridZ = new Vector3()

  const lift = (plane: PlaneArg, x: number, y: number): [number, number, number] => {
    const world = toWorld(plane, x, y)
    const normal = asWorkPlane(plane).normal
    return [world[0] + normal[0] * 0.15, world[1] + normal[1] * 0.15, world[2] + normal[2] * 0.15]
  }

  const worldPolyline = (points: Array<[number, number]>) =>
    points.map((point) => lift(session.plane, point[0], point[1]))

  const redrawCommitted = () => {
    const kept = lineMaterials.filter((material) => {
      const inPreview = previewGroup.children.some(
        (child) => (child as Line2).material === material,
      )
      const inMeasure = measureGroup.children.some(
        (child) => (child as Line2).material === material,
      )
      return inPreview || inMeasure
    })
    clearGroup(sketchGroup)
    lineMaterials.length = 0
    lineMaterials.push(...kept)
    for (const entity of session.entities) {
      const polyline = entityPolyline(entity)
      if (polyline) addPolyline(sketchGroup, worldPolyline(polyline), SKETCH)
    }
  }

  const redrawPreview = () => {
    const kept = lineMaterials.filter(
      (material) => !previewGroup.children.some((child) => (child as Line2).material === material),
    )
    clearGroup(previewGroup)
    lineMaterials.length = 0
    lineMaterials.push(...kept)
    const polyline = previewPolyline(
      session.sketchTool,
      session.placed,
      session.cursor,
      session.polygonSides,
    )
    if (polyline) addPolyline(previewGroup, worldPolyline(polyline), SKETCH_PREVIEW)
  }

  const redrawMeasure = () => {
    const kept = lineMaterials.filter(
      (material) => !measureGroup.children.some((child) => (child as Line2).material === material),
    )
    clearGroup(measureGroup)
    lineMaterials.length = 0
    lineMaterials.push(...kept)
    const measure = session.measure
    if (!measure?.a || !measure.b) return
    if (worldDistance(measure.a, measure.b) < 1e-6) return
    addPolyline(measureGroup, [measure.a, measure.b], MEASURE)
  }

  const orientGrid = (grid: GridHelper, plane: PlaneArg) => {
    const frame = asWorkPlane(plane)
    grid.position.set(frame.origin[0], frame.origin[1], frame.origin[2])
    gridX.set(frame.u[0], frame.u[1], frame.u[2])
    gridY.set(frame.normal[0], frame.normal[1], frame.normal[2])
    gridZ.crossVectors(gridX, gridY)
    if (gridZ.lengthSq() < 1e-8) return
    grid.quaternion.setFromRotationMatrix(gridBasis.makeBasis(gridX, gridY, gridZ))
  }

  /** Quad outlines for the datum planes, plus a translucent face to click on. */
  let planeHover: DatumPlane | null = null
  /** Plane id per quad mesh, kept beside the group so picking needs no cast. */
  const planeIds = new Map<Object3D, DatumPlane>()

  const buildPlanes = (visible: readonly DatumPlane[]) => {
    for (const child of [...planeGroup.children]) {
      disposeObject(child)
      planeGroup.remove(child)
    }
    planeIds.clear()
    for (const place of planePlacements()) {
      if (!visible.includes(place.id)) continue
      const corners = planeCorners(place)
      const a = corners[0]
      const b = corners[1]
      const c = corners[2]
      const d = corners[3]
      if (!a || !b || !c || !d) continue

      const geometry = new BufferGeometry()
      // Two triangles from the quad's four corners.
      geometry.setAttribute(
        'position',
        new Float32BufferAttribute([...a, ...b, ...c, ...a, ...c, ...d], 3),
      )
      geometry.computeVertexNormals()
      const mesh = new Mesh(
        geometry,
        new MeshBasicMaterial({
          color: PLANE_FACE,
          transparent: true,
          opacity: 0.16,
          side: DoubleSide,
          depthWrite: false,
        }),
      )
      planeGroup.add(mesh)
      planeIds.set(mesh, place.id)

      // The outline, so the plane reads as a rectangle rather than a wash.
      const outlineGeometry = new BufferGeometry()
      outlineGeometry.setAttribute(
        'position',
        new Float32BufferAttribute([...a, ...b, ...c, ...d, ...a], 3),
      )
      planeGroup.add(
        new Line(
          outlineGeometry,
          new LineBasicMaterial({ color: PLANE_EDGE, transparent: true, opacity: 0.55 }),
        ),
      )
    }
  }

  const planeAt = (event: { clientX: number; clientY: number }): DatumPlane | null => {
    if (planeIds.size === 0) return null
    const ray = pointerRay(event)
    if (!ray) return null
    raycaster.firstHitOnly = false
    const hits = raycaster.intersectObjects([...planeIds.keys()], false)
    raycaster.firstHitOnly = true
    const hit = hits[0]
    return hit ? (planeIds.get(hit.object) ?? null) : null
  }

  const setPlaneHover = (next: DatumPlane | null) => {
    if (planeHover === next) return
    planeHover = next
    for (const [object, id] of planeIds) {
      if (!(object instanceof Mesh)) continue
      const material = object.material as MeshBasicMaterial
      const on = id === next
      material.opacity = on ? 0.34 : 0.16
      material.color.setHex(on ? PLANE_FACE_HOVER : PLANE_FACE)
    }
    renderer.domElement.style.cursor = next ? 'pointer' : session.sketchMode ? 'crosshair' : ''
  }

  const syncGrid = () => {
    if (sketchGrid) {
      scene.remove(sketchGrid)
      sketchGrid.geometry.dispose()
      const material = sketchGrid.material
      if (Array.isArray(material)) for (const item of material) item.dispose()
      sketchGrid = null
    }
    if (!session.sketchMode) return
    sketchGrid = new GridHelper(200, 40, 0x3a3a3a, 0x2c2c2c)
    orientGrid(sketchGrid, session.plane)
    scene.add(sketchGrid)
  }

  const projectLabel = (world: [number, number, number]): { x: number; y: number } | null => {
    projected.set(world[0], world[1], world[2])
    camera.getWorldDirection(forward)
    if (projected.clone().sub(camera.position).dot(forward) <= 0) return null
    projected.project(camera)
    return {
      x: (projected.x * 0.5 + 0.5) * host.clientWidth,
      y: (-projected.y * 0.5 + 0.5) * host.clientHeight,
    }
  }

  const liveDimension = () =>
    session.sketchMode &&
    session.placed.length > 0 &&
    (session.sketchTool === 'line' ||
      session.sketchTool === 'rectangle' ||
      session.sketchTool === 'circle')

  const publishDraft = () => {
    if (!liveDimension() || !session.cursor) {
      hooks.onDraft(null)
      return
    }
    const note = previewAnnotation(
      session.sketchTool,
      session.placed,
      session.cursor,
      session.polygonSides,
    )
    const at = note?.at ?? session.cursor
    const screen = projectLabel(toWorld(session.plane, at[0], at[1]))
    if (!screen) {
      hooks.onDraft(null)
      return
    }
    const label =
      session.sketchTool === 'line'
        ? 'Length'
        : session.sketchTool === 'circle'
          ? 'Radius'
          : 'Width, height'
    hooks.onDraft({
      x: screen.x,
      y: screen.y,
      placeholder: note?.text || label,
      label,
    })
  }

  const publishLabels = () => {
    const labels: OverlayLabel[] = []
    if (session.sketchMode) {
      for (const entity of session.entities) {
        const note = entityAnnotation(entity)
        if (!note) continue
        const screen = projectLabel(toWorld(session.plane, note.at[0], note.at[1]))
        if (!screen) continue
        labels.push({ id: entity.id, text: note.text, ...screen, kind: 'sketch' })
      }
      if (!liveDimension()) {
        const preview = previewAnnotation(
          session.sketchTool,
          session.placed,
          session.cursor,
          session.polygonSides,
        )
        if (preview) {
          const screen = projectLabel(toWorld(session.plane, preview.at[0], preview.at[1]))
          if (screen) labels.push({ id: 'preview', text: preview.text, ...screen, kind: 'sketch' })
        }
      }
      if (session.cursor && session.snapKind) {
        const screen = projectLabel(toWorld(session.plane, session.cursor[0], session.cursor[1]))
        if (screen) {
          labels.push({
            id: 'snap',
            text: snapCaption(session.snapKind),
            x: screen.x,
            y: screen.y,
            kind: 'snap',
          })
        }
      }
    }
    const measure = session.measure
    if (measure?.a && measure.b && worldDistance(measure.a, measure.b) >= 1e-6) {
      const mid: [number, number, number] = [
        (measure.a[0] + measure.b[0]) / 2,
        (measure.a[1] + measure.b[1]) / 2,
        (measure.a[2] + measure.b[2]) / 2,
      ]
      const screen = projectLabel(mid)
      if (screen) {
        labels.push({
          id: 'measure',
          text: measure.label ?? `${formatLength(worldDistance(measure.a, measure.b))} mm`,
          ...screen,
          kind: 'measure',
        })
      }
    }
    hooks.onLabels(labels)
    publishDraft()
  }

  const clearHover = () => {
    hoverKey = ''
    clearGroup(hoverGroup)
  }

  const faceGeometry = (source: BufferGeometry, triangleIndex: number, groups?: FaceGroup[]) => {
    const position = source.getAttribute('position')
    const index = source.getIndex()
    if (!position) return null
    const indexCount = index ? index.count : position.count
    const found = faceAt(groups, triangleIndex, indexCount)
    const spans = found?.triangles ?? [{ start: triangleIndex, count: 1 }]
    const positions: number[] = []
    for (const span of spans) {
      const count = Math.max(0, Math.floor(span.count))
      for (let tri = Math.floor(span.start); tri < Math.floor(span.start) + count; tri++) {
        for (let corner = 0; corner < 3; corner++) {
          const vertex = index ? index.getX(tri * 3 + corner) : tri * 3 + corner
          positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
        }
      }
    }
    if (positions.length === 0) return null
    const overlay = new BufferGeometry()
    overlay.setAttribute('position', new Float32BufferAttribute(positions, 3))
    overlay.computeVertexNormals()
    return overlay
  }

  const showHover = (found: Found | null) => {
    if (!found) {
      if (hoverKey) clearHover()
      return
    }
    const key = selectionKey(found)
    if (key === hoverKey) return
    clearHover()
    hoverKey = key
    const overlay = buildOverlay(found, found.index, HOVER, 0.42, found.point)
    if (overlay) hoverGroup.add(overlay)
  }

  const partOf = (featureId: string, kind: 'mesh' | 'line') =>
    parts.children.find(
      (child) =>
        featureIdOf(child) === featureId &&
        (kind === 'mesh' ? child instanceof Mesh : child instanceof LineSegments),
    )

  /** Edge ranges in vertex space, whether the groups count vertices or segments. */
  const edgeRanges = (line: LineSegments) => {
    const position = line.geometry.getAttribute('position')
    const count = position?.count ?? 0
    const groups = line.userData.edgeGroups as EdgeGroup[] | null | undefined
    if (!groups?.length) {
      return Array.from({ length: Math.floor(count / 2) }, (_, segment) => ({
        edgeId: segment * 2,
        start: segment * 2,
        count: 2,
      }))
    }
    const sum = groups.reduce((total, group) => total + group.count, 0)
    const scale = count > 0 && sum === count / 2 ? 2 : 1
    return groups.map((group) => ({
      edgeId: group.edgeId,
      start: group.start * scale,
      count: group.count * scale,
    }))
  }

  const vertexAt = (line: LineSegments, index: number, target: Vector3) =>
    target
      .set(
        line.geometry.getAttribute('position').getX(index),
        line.geometry.getAttribute('position').getY(index),
        line.geometry.getAttribute('position').getZ(index),
      )
      .applyMatrix4(line.matrixWorld)

  /** Endpoints of every edge. Vertex ids are edgeId * 2 (first) and edgeId * 2 + 1 (last). */
  const edgeEnds = (line: LineSegments) => {
    const out: Array<{ id: number; vertex: number }> = []
    for (const range of edgeRanges(line)) {
      out.push({ id: range.edgeId * 2, vertex: range.start })
      out.push({ id: range.edgeId * 2 + 1, vertex: range.start + range.count - 1 })
    }
    return out
  }

  /** Face or edge range an item stands for, as a triangle index or first vertex. */
  const locate = (item: SelectionItem): { index: number; point?: Vector3 } | null => {
    if (item.kind === 'face') {
      const mesh = partOf(item.featureId, 'mesh') as Mesh | undefined
      if (!mesh) return null
      const groups = mesh.userData.faceGroups as FaceGroup[] | null | undefined
      const indexAttr = mesh.geometry.getIndex()
      const total = indexAttr
        ? indexAttr.count
        : (mesh.geometry.getAttribute('position')?.count ?? 0)
      if (!groups?.length) return item.id * 3 < total ? { index: item.id } : null
      const triangle = faceTriangle(groups, item.id, total)
      return triangle == null ? null : { index: triangle }
    }
    const line = partOf(item.featureId, 'line') as LineSegments | undefined
    if (!line) return null
    if (item.kind === 'edge') {
      const range = edgeRanges(line).find((entry) => entry.edgeId === item.id)
      return range ? { index: range.start } : null
    }
    const end = edgeEnds(line).find((entry) => entry.id === item.id)
    return end ? { index: end.vertex, point: vertexAt(line, end.vertex, new Vector3()) } : null
  }

  const buildOverlay = (
    item: SelectionItem,
    index: number,
    color: number,
    opacity: number,
    point?: Vector3,
  ): Object3D | null => {
    if (item.kind === 'face') {
      const mesh = partOf(item.featureId, 'mesh') as Mesh | undefined
      if (!mesh) return null
      const geometry = faceGeometry(
        mesh.geometry,
        index,
        mesh.userData.faceGroups as FaceGroup[] | undefined,
      )
      if (!geometry) return null
      const overlay = new Mesh(
        geometry,
        new MeshBasicMaterial({
          color,
          transparent: true,
          opacity,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
          polygonOffsetUnits: -2,
        }),
      )
      overlay.raycast = () => {}
      overlay.position.copy(mesh.position)
      overlay.quaternion.copy(mesh.quaternion)
      overlay.scale.copy(mesh.scale)
      return overlay
    }
    const line = partOf(item.featureId, 'line') as LineSegments | undefined
    if (!line) return null
    if (item.kind === 'vertex') {
      if (!point) return null
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute([point.x, point.y, point.z], 3))
      const dot = new Points(
        geometry,
        new PointsMaterial({ color, size: 8, sizeAttenuation: false, depthTest: false }),
      )
      dot.raycast = () => {}
      dot.renderOrder = 2
      return dot
    }
    const position = line.geometry.getAttribute('position')
    const range = edgeRanges(line).find(
      (entry) => index >= entry.start && index < entry.start + entry.count,
    )
    const start = range?.start ?? index
    const end = Math.min(position.count, start + (range?.count ?? 2))
    const positions: number[] = []
    for (let vertex = start; vertex < end; vertex++) {
      positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
    }
    if (positions.length < 6) return null
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    const highlight = new LineSegments(
      geometry,
      new LineBasicMaterial({
        color,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    )
    highlight.raycast = () => {}
    return highlight
  }

  const pointerRay = (event: { clientX: number; clientY: number }) => {
    const box = renderer.domElement.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) return null
    pointer.x = ((event.clientX - box.left) / box.width) * 2 - 1
    pointer.y = -((event.clientY - box.top) / box.height) * 2 + 1
    const distance = camera.position.distanceTo(controls.target)
    raycaster.params.Line.threshold = edgePickThreshold(distance)
    raycaster.setFromCamera(pointer, camera)
    return raycaster.ray
  }

  const screenOf = (point: Vector3, box: DOMRect) => {
    projected.copy(point).project(camera)
    return {
      x: ((projected.x + 1) / 2) * box.width,
      y: ((1 - projected.y) / 2) * box.height,
    }
  }

  /** Ordered hits under the cursor for the active filter. */
  const findHits = (event: { clientX: number; clientY: number }): Found[] => {
    const ray = pointerRay(event)
    if (!ray) return []
    const box = renderer.domElement.getBoundingClientRect()
    const cx = event.clientX - box.left
    const cy = event.clientY - box.top
    const meshes = parts.children.filter((child) => child instanceof Mesh)
    const lines = parts.children.filter((child) => child instanceof LineSegments)
    const filter = session.pickMode
    const candidates: Found[] = []
    raycaster.firstHitOnly = false
    const faces = raycaster.intersectObjects(meshes, false)
    raycaster.firstHitOnly = true
    const face = faces[0]
    const faceDepth = face ? face.distance : Number.POSITIVE_INFINITY
    // Lines lying on a face tie with it, so allow a small slack before calling them hidden.
    const slack = camera.position.distanceTo(controls.target) * 0.01

    if (filter === 'face') {
      for (const face of faces) {
        if (!(face.object instanceof Mesh) || face.faceIndex == null) continue
        const groups = face.object.userData.faceGroups as FaceGroup[] | undefined
        const indexAttr = face.object.geometry.getIndex()
        const total = indexAttr
          ? indexAttr.count
          : (face.object.geometry.getAttribute('position')?.count ?? 0)
        const found = faceAt(groups, face.faceIndex, total)
        candidates.push({
          kind: 'face',
          featureId: featureIdOf(face.object),
          id: found?.faceId ?? face.faceIndex,
          depth: face.distance,
          screenPx: 0,
          object: face.object,
          index: face.faceIndex,
          point: face.point,
        })
      }
    } else if (filter === 'edge') {
      for (const child of lines) {
        const line = child as LineSegments
        for (const range of edgeRanges(line)) {
          for (let index = range.start; index + 1 < range.start + range.count; index += 2) {
            const a = vertexAt(line, index, new Vector3())
            const b = vertexAt(line, index + 1, new Vector3())
            const sa = screenOf(a, box)
            const sb = screenOf(b, box)
            const screenPx = segmentDistancePx(cx, cy, sa.x, sa.y, sb.x, sb.y)
            const point = new Vector3()
            ray.distanceSqToSegment(a, b, undefined, point)
            const depth = point.distanceTo(ray.origin)
            if (depth > faceDepth + slack) continue
            candidates.push({
              kind: 'edge',
              featureId: featureIdOf(line),
              id: range.edgeId,
              depth,
              screenPx,
              object: line,
              index: range.start,
              point,
            })
          }
        }
      }
    } else if (filter === 'vertex') {
      const scratch = new Vector3()
      for (const child of lines) {
        const line = child as LineSegments
        for (const end of edgeEnds(line)) {
          vertexAt(line, end.vertex, scratch)
          const depth = scratch.distanceTo(ray.origin)
          if (depth > faceDepth + slack) continue
          const screen = screenOf(scratch, box)
          candidates.push({
            kind: 'vertex',
            featureId: featureIdOf(line),
            id: end.id,
            depth,
            screenPx: Math.hypot(screen.x - cx, screen.y - cy),
            object: line,
            index: end.vertex,
            point: scratch.clone(),
          })
        }
      }
    }
    return rankedHits(candidates, filter)
  }

  const hitOf = (found: Found): PickHit => {
    const hit: PickHit = {
      kind: found.kind,
      featureId: found.featureId,
      index: found.index,
      point: pointTuple(found.point),
    }
    if (found.kind === 'face') hit.faceId = found.id
    else if (found.kind === 'edge') hit.edgeId = found.id
    else hit.vertexId = found.id
    return hit
  }

  const hoverAt = (event: PointerEvent) => {
    if (session.sketchMode) {
      clearHover()
      return
    }
    cycleHits = findHits(event)
    cycleIndex = 0
    showHover(cycleHits[0] ?? null)
  }

  const selectionHits = (): PickHit[] => {
    const out: PickHit[] = []
    for (const item of selection) {
      const spot = locate(item)
      if (!spot) continue
      const hit: PickHit = { kind: item.kind, featureId: item.featureId, index: spot.index }
      if (spot.point) hit.point = pointTuple(spot.point)
      if (item.kind === 'face') hit.faceId = item.id
      else if (item.kind === 'edge') hit.edgeId = item.id
      else hit.vertexId = item.id
      out.push(hit)
    }
    return out
  }

  /** Redraws the highlights and drops items that no longer exist after a rebuild. */
  const redrawSelection = () => {
    clearGroup(selectGroup)
    const kept: SelectionItem[] = []
    for (const item of selection) {
      const spot = locate(item)
      if (!spot) continue
      const overlay = buildOverlay(item, spot.index, SELECTED, 0.55, spot.point)
      if (!overlay) continue
      selectGroup.add(overlay)
      kept.push(item)
    }
    return kept
  }

  const setSelection = (next: SelectionItem[]) => {
    const before = selection.map(selectionKey).join('|')
    selection = next
    selection = redrawSelection()
    if (selection.map(selectionKey).join('|') !== before) hooks.onSelectionChange(selectionHits())
  }

  const pick = (event: PointerEvent): PickHit | null => {
    const found =
      lastPointer && event.clientX === lastPointer.clientX && event.clientY === lastPointer.clientY
        ? (cycleHits[cycleIndex] ?? null)
        : (findHits(event)[0] ?? null)
    const additive = event.shiftKey
    const next = toggleSelection(selection, found, additive)
    setSelection(next)
    if (!found) return null
    // Removing an item from the set is not a new pick.
    if (additive && !next.some((entry) => sameItem(entry, found))) return null
    return hitOf(found)
  }

  /** Projected centers of every item of the active kind, for box select. */
  const boxCenters = (box: DOMRect): CenterItem[] => {
    const out: CenterItem[] = []
    const filter = session.pickMode
    const center = new Vector3()
    if (filter === 'face') {
      for (const child of parts.children) {
        if (!(child instanceof Mesh)) continue
        const groups = child.userData.faceGroups as FaceGroup[] | null | undefined
        const position = child.geometry.getAttribute('position')
        const indexAttr = child.geometry.getIndex()
        const total = indexAttr ? indexAttr.count : (position?.count ?? 0)
        const seen = new Set<number>()
        for (const group of groups ?? []) {
          if (seen.has(group.faceId)) continue
          seen.add(group.faceId)
          const triangle = faceTriangle(groups ?? undefined, group.faceId, total)
          const geometry =
            triangle == null ? null : faceGeometry(child.geometry, triangle, groups ?? undefined)
          if (!geometry) continue
          geometry.computeBoundingBox()
          geometry.boundingBox?.getCenter(center)
          geometry.dispose()
          const screen = screenOf(center.applyMatrix4(child.matrixWorld), box)
          out.push({ kind: 'face', featureId: featureIdOf(child), id: group.faceId, ...screen })
        }
      }
      return out
    }
    for (const child of parts.children) {
      if (!(child instanceof LineSegments)) continue
      const featureId = featureIdOf(child)
      if (filter === 'vertex') {
        for (const end of edgeEnds(child)) {
          const screen = screenOf(vertexAt(child, end.vertex, center), box)
          out.push({ kind: 'vertex', featureId, id: end.id, ...screen })
        }
        continue
      }
      for (const range of edgeRanges(child)) {
        const first = vertexAt(child, range.start, center).clone()
        const last = vertexAt(child, range.start + range.count - 1, center)
        const screen = screenOf(first.add(last).multiplyScalar(0.5), box)
        out.push({ kind: 'edge', featureId, id: range.edgeId, ...screen })
      }
    }
    return out
  }

  const sketchCursor = (event: {
    clientX: number
    clientY: number
    shiftKey: boolean
  }): { point: [number, number]; kind: SnapKind } | null => {
    const ray = pointerRay(event)
    if (!ray) return null
    const hit = projectRayToPlane(
      [ray.origin.x, ray.origin.y, ray.origin.z],
      [ray.direction.x, ray.direction.y, ray.direction.z],
      session.plane,
    )
    if (!hit) return null
    const distance = camera.position.distanceTo(controls.target)
    const anchor = session.placed[session.placed.length - 1] ?? null
    return resolveSnap({
      cursor: hit,
      tolerance: sketchSnapTolerance(distance),
      gridStep: gridStepForShift(session.snap, event.shiftKey),
      anchor,
      entities: session.entities,
      enabled: session.snapEnabled,
      settings: session.snapSettings,
    })
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    down = true
    downX = event.clientX
    downY = event.clientY
    host.parentElement?.focus({ preventScroll: true })
  }

  // Ctrl/Cmd + drag draws a selection rectangle. Runs in the capture phase so
  // orbit never sees the gesture; a plain drag still orbits.
  const onBoxStart = (event: PointerEvent) => {
    if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || session.sketchMode) return
    if (event.target !== renderer.domElement) return
    boxing = true
    controls.enabled = false
    const box = renderer.domElement.getBoundingClientRect()
    boxFrame = document.createElement('div')
    boxFrame.className = 'cad-box-select'
    boxFrame.style.display = 'none'
    host.appendChild(boxFrame)
    boxFrom = { x: event.clientX - box.left, y: event.clientY - box.top }
  }

  const endBox = () => {
    boxing = false
    controls.enabled = true
    boxFrame?.remove()
    boxFrame = null
  }

  const onPointerMove = (event: PointerEvent) => {
    const moved =
      !lastPointer || event.clientX !== lastPointer.clientX || event.clientY !== lastPointer.clientY
    lastPointer = event
    if (!moved && !boxing) return
    if (boxing && boxFrame) {
      const box = renderer.domElement.getBoundingClientRect()
      const x = event.clientX - box.left
      const y = event.clientY - box.top
      boxFrame.style.display = 'block'
      boxFrame.style.left = `${Math.min(boxFrom.x, x)}px`
      boxFrame.style.top = `${Math.min(boxFrom.y, y)}px`
      boxFrame.style.width = `${Math.abs(x - boxFrom.x)}px`
      boxFrame.style.height = `${Math.abs(y - boxFrom.y)}px`
      return
    }
    if (session.sketchMode) {
      const snap = sketchCursor(event)
      session.cursor = snap?.point ?? null
      session.snapKind = snap?.kind ?? null
      redrawPreview()
      return
    }
    // A datum plane under the pointer takes the hover, so it is obvious it can be clicked.
    setPlaneHover(planeAt(event))
    if (planeHover) return
    hoverAt(event)
  }

  const onPointerUp = (event: PointerEvent) => {
    if (!down || event.button !== 0) return
    down = false
    const dragged = Math.hypot(event.clientX - downX, event.clientY - downY) > 4
    if (boxing) {
      endBox()
      if (dragged) {
        const box = renderer.domElement.getBoundingClientRect()
        const found = boxSelect(
          boxCenters(box),
          {
            x0: downX - box.left,
            y0: downY - box.top,
            x1: event.clientX - box.left,
            y1: event.clientY - box.top,
          },
          session.pickMode,
        )
        setSelection(event.shiftKey ? mergeSelection(selection, found) : found)
        return
      }
    }
    if (dragged) return
    if (session.sketchMode) {
      const snap = sketchCursor(event)
      if (!snap) return
      session.cursor = snap.point
      session.snapKind = snap.kind
      const next = advanceSketch(
        session.sketchTool,
        session.placed,
        snap.point,
        `e${sketchSeq}`,
        session.polygonSides,
      )
      session.placed = next.placed
      session.chaining = next.chaining === true && session.placed.length > 0
      // A polygon arrives as several segments; a line or polyline as one.
      const added = next.entities ?? (next.entity ? [next.entity] : [])
      // Points placed toward the active shape, not the open draft. A finished
      // shape reports one past its draft so the counter can complete; a chaining
      // tool keeps re-anchoring and never runs past its repeat step.
      const committed = added.length > 0 ? session.placed.length + 1 : session.placed.length
      hooks.onSketchPlaced(session.chaining ? Math.max(committed, 1) : committed)
      if (added.length > 0) {
        sketchSeq += 1
        session.entities = [...session.entities, ...added]
        hooks.onSketchChange(session.entities)
        redrawCommitted()
      }
      redrawPreview()
      publishLabels()
      return
    }
    // Clicking a datum plane starts a sketch on it.
    const plane = planeAt(event)
    if (plane) {
      setPlaneHover(null)
      hooks.onPlanePick(plane)
      return
    }
    hooks.onPick(pick(event))
  }

  const onPointerLeave = () => {
    lastPointer = null
    cycleHits = []
    cycleIndex = 0
    session.cursor = null
    session.snapKind = null
    if (session.sketchMode) redrawPreview()
    else clearHover()
  }

  const onKey = (event: KeyboardEvent) => {
    if (!lastPointer) return
    if (
      event.type === 'keydown' &&
      event.key === 'Tab' &&
      !event.shiftKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey &&
      !(
        event.target instanceof HTMLElement &&
        (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName))
      ) &&
      !session.sketchMode &&
      !boxing &&
      cycleHits.length > 1
    ) {
      event.preventDefault()
      cycleIndex = (cycleIndex + 1) % cycleHits.length
      showHover(cycleHits[cycleIndex] ?? null)
      return
    }
    if (event.key !== 'Shift') return
    if (session.sketchMode) {
      const snap = sketchCursor({
        clientX: lastPointer.clientX,
        clientY: lastPointer.clientY,
        shiftKey: event.type === 'keydown',
      })
      session.cursor = snap?.point ?? null
      session.snapKind = snap?.kind ?? null
      redrawPreview()
      return
    }
  }

  host.addEventListener('pointerdown', onBoxStart, true)
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointermove', onPointerMove)
  renderer.domElement.addEventListener('pointerup', onPointerUp)
  renderer.domElement.addEventListener('pointerleave', onPointerLeave)
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)

  const clearParts = () => {
    cycleHits = []
    cycleIndex = 0
    clearHover()
    for (const child of [...parts.children]) {
      disposeObject(child)
      parts.remove(child)
    }
  }

  const setMeshes = (meshes: MeshBuffers[], selectedId: string | null) => {
    clearParts()
    for (const mesh of meshes) {
      if (mesh.positions.length === 0) continue
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new Float32BufferAttribute(mesh.positions, 3))
      if (mesh.normals && mesh.normals.length > 0) {
        geometry.setAttribute('normal', new Float32BufferAttribute(mesh.normals, 3))
      } else {
        geometry.computeVertexNormals()
      }
      if (mesh.indices && mesh.indices.length > 0) {
        geometry.setIndex(new BufferAttribute(mesh.indices, 1))
      }
      geometry.computeBoundsTree({ indirect: true })
      const selected = mesh.id === selectedId
      const solid = new Mesh(
        geometry,
        new MeshStandardMaterial({
          color: selected ? SOLID_SELECTED : SOLID,
          roughness: 0.52,
          metalness: 0.04,
          flatShading: false,
          emissive: selected ? 0x24282c : 0x000000,
        }),
      )
      solid.userData = { featureId: mesh.id, faceGroups: mesh.faceGroups ?? null }
      parts.add(solid)

      let edgeGeometry: BufferGeometry
      let edgeGroups: EdgeGroup[] | null = null
      if (mesh.edgePositions && mesh.edgePositions.length >= 6) {
        edgeGeometry = new BufferGeometry()
        edgeGeometry.setAttribute('position', new Float32BufferAttribute(mesh.edgePositions, 3))
        edgeGroups = mesh.edgeGroups ?? null
      } else {
        edgeGeometry = new EdgesGeometry(geometry)
      }
      const edges = new LineSegments(
        edgeGeometry,
        new LineBasicMaterial({ color: selected ? EDGE_HOVER : EDGE }),
      )
      edges.userData = { featureId: mesh.id, edgeGroups }
      parts.add(edges)
    }
    const before = selection.length
    selection = redrawSelection()
    if (selection.length !== before) hooks.onSelectionChange(selectionHits())
  }

  const setInteraction = (
    next: Omit<SceneSession, 'placed' | 'chaining' | 'cursor' | 'snapKind'>,
  ) => {
    const resetDraft =
      next.sketchTool !== session.sketchTool ||
      planeKey(next.plane) !== planeKey(session.plane) ||
      next.sketchMode !== session.sketchMode
    const wasSketching = session.sketchMode
    const previousPlane = session.plane
    session.sketchMode = next.sketchMode
    session.sketchTool = next.sketchTool
    session.plane = next.plane
    session.snap = next.snap
    session.polygonSides = next.polygonSides
    session.snapEnabled = next.snapEnabled
    session.snapSettings = next.snapSettings
    if (next.pickMode !== session.pickMode) {
      session.pickMode = next.pickMode
      cycleHits = []
      cycleIndex = 0
      clearHover()
      setSelection(keepKind(selection, next.pickMode))
    }
    session.entities = next.entities
    session.measure = next.measure
    // Sketching looks straight down the plane with the orbit locked; modelling
    // goes back to a perspective you can turn around.
    if (next.sketchMode !== wasSketching) {
      if (next.sketchMode) {
        framePlane(next.plane)
        controls.enableRotate = false
      } else {
        controls.enableRotate = true
        frameModel()
      }
    } else if (next.sketchMode && planeKey(next.plane) !== planeKey(previousPlane)) {
      // A new sketch plane needs a new view onto it.
      framePlane(next.plane)
    }
    if (resetDraft) {
      session.placed = []
      session.cursor = null
      session.snapKind = null
      hooks.onSketchPlaced(0)
    }
    renderer.domElement.style.cursor = session.sketchMode ? 'crosshair' : ''
    if (session.sketchMode) {
      cycleHits = []
      cycleIndex = 0
      clearHover()
    } else if (lastPointer && cycleHits.length === 0) {
      hoverAt(lastPointer)
    }
    syncGrid()
    // The planes are a starting point, not permanent scenery: they go away once
    // there is geometry to look at.
    buildPlanes(visiblePlanes(parts.children.length > 0, session.sketchMode))
    redrawCommitted()
    redrawPreview()
    redrawMeasure()
    publishLabels()
  }

  const cancelSketch = () => {
    session.placed = []
    session.cursor = null
    session.snapKind = null
    redrawPreview()
    publishLabels()
  }

  const finishSketch = () => {
    session.placed = []
    session.cursor = null
    session.snapKind = null
    redrawPreview()
    hooks.onSketchFinish(session.entities)
    publishLabels()
  }

  const applyDraftDimension = (text: string): boolean => {
    if (!session.sketchMode) return false
    const next = commitLiveDimension(
      session.sketchTool,
      session.placed,
      session.cursor,
      text,
      `e${sketchSeq}`,
    )
    if (!next) return false
    session.placed = next.placed
    if (next.entity) {
      sketchSeq += 1
      session.entities = [...session.entities, next.entity]
      hooks.onSketchChange(session.entities)
      redrawCommitted()
    }
    redrawPreview()
    publishLabels()
    return true
  }

  const applyEntityDimension = (id: string, text: string): boolean => {
    const index = session.entities.findIndex((entity) => entity.id === id)
    const current = index >= 0 ? session.entities[index] : undefined
    if (!current) return false
    const next = applyDimensionToEntity(current, text)
    if (!next) return false
    const entities = session.entities.slice()
    entities[index] = next
    session.entities = entities
    hooks.onSketchChange(entities)
    redrawCommitted()
    publishLabels()
    return true
  }

  const fit = () => {
    const box = new Box3()
    for (const child of parts.children) {
      if (child instanceof Mesh) box.expandByObject(child)
    }
    for (const child of sketchGroup.children) box.expandByObject(child)
    const dir = camera.position.clone().sub(controls.target)
    if (dir.lengthSq() < 1e-6) {
      const iso = viewDirection('iso')
      dir.set(iso[0], iso[1], iso[2])
    }
    dir.normalize()
    if (box.isEmpty()) {
      controls.target.set(0, 0, 0)
      camera.position.copy(dir.multiplyScalar(140))
    } else {
      const size = box.getSize(new Vector3())
      const center = box.getCenter(new Vector3())
      const maxDim = Math.max(size.x, size.y, size.z, 1)
      const vertical = (camera.fov * Math.PI) / 180
      const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(camera.aspect, 0.05))
      const dist = (maxDim / 2 / Math.tan(Math.min(vertical, horizontal) / 2)) * 1.4
      controls.target.copy(center)
      camera.position.copy(center).addScaledVector(dir, dist)
      camera.near = Math.max(dist / 100, 0.01)
      camera.far = dist * 100
    }
    camera.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2])
    camera.updateProjectionMatrix()
    controls.update()
  }

  /** Default field of view for modelling. Narrowing it flattens the projection. */
  const MODEL_FOV = 45
  /**
   * Field of view used while sketching.
   *
   * A true orthographic swap means a second camera object, and this camera is
   * referenced throughout the scene. Narrowing the field of view instead gives
   * a near-parallel projection: at 8 degrees across a 1.6 aspect the edge
   * distortion is under a percent, which is indistinguishable from orthographic
   * on a sketch. The distance grows to keep the same area in frame.
   */
  const SKETCH_FOV = 8

  /** Scale the view so a body at `extent` still fills the frame at this fov. */
  const distanceForExtent = (extent: number, fov: number) => {
    const vertical = (fov * Math.PI) / 180
    const horizontal = 2 * Math.atan(Math.tan(vertical / 2) * Math.max(camera.aspect, 0.05))
    return (extent / 2 / Math.tan(Math.min(vertical, horizontal) / 2)) * 1.2
  }

  const setFov = (fov: number) => {
    if (Math.abs(camera.fov - fov) < 1e-6) return
    camera.fov = fov
    camera.updateProjectionMatrix()
  }

  /**
   * Look straight down a workplane.
   *
   * Sketching from a perspective isometric is close to unusable: screen
   * positions land on the tilted plane at a steep angle, so a rectangle drawn
   * as 400 by 250 arrives as a sliver. Looking down the normal removes the skew
   * and the narrowed field of view keeps a 2D drawing square at the edges.
   */
  const framePlane = (plane: PlaneArg) => {
    const frame = asWorkPlane(plane)
    const normal = new Vector3(frame.normal[0], frame.normal[1], frame.normal[2])
    if (normal.lengthSq() < 1e-9) return
    normal.normalize()
    const up = new Vector3(frame.u[0], frame.u[1], frame.u[2]).normalize()
    const origin = new Vector3(frame.origin[0], frame.origin[1], frame.origin[2])

    // Frame what is already drawn, so a reopened sketch lands where it left off.
    const box = new Box3()
    for (const child of sketchGroup.children) box.expandByObject(child)
    const size = box.isEmpty() ? 100 : Math.max(box.getSize(new Vector3()).length(), 20)
    const center = box.isEmpty() ? origin : box.getCenter(new Vector3())

    setFov(SKETCH_FOV)
    camera.up.copy(up)
    controls.target.copy(center)
    camera.position.copy(center).addScaledVector(normal, distanceForExtent(size * 1.6, SKETCH_FOV))
    camera.lookAt(center)
    camera.updateProjectionMatrix()
    controls.update()
  }

  /**
   * Back to perspective at a modelling field of view.
   *
   * Widening the field of view alone leaves the camera where the sketch left it,
   * which is very far away for the narrow sketch fov, so the part arrives as a
   * speck. Pull the distance back by the same ratio to hold the framing.
   */
  const frameModel = () => {
    const was = camera.fov
    if (Math.abs(was - MODEL_FOV) > 1e-6) {
      const ratio = Math.tan((was * Math.PI) / 360) / Math.tan((MODEL_FOV * Math.PI) / 360)
      const offset = camera.position.clone().sub(controls.target)
      const moved = offset.multiplyScalar(ratio)
      camera.position.copy(controls.target).add(moved)
    }
    setFov(MODEL_FOV)
    camera.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2])
    // Leaving a sketch also leaves the axis it was drawn on. Keeping the camera
    // dead-on to that axis makes a fresh extrusion read as flat faces, so swing
    // to the isometric direction the same way a standard view does.
    const iso = new Vector3(...viewDirection('iso'))
    const dist = camera.position.distanceTo(controls.target)
    camera.position.copy(controls.target).addScaledVector(iso, dist)
    camera.lookAt(controls.target)
    camera.updateProjectionMatrix()
    controls.update()
  }

  /**
   * Fly the camera to a standard view.
   *
   * The move is interpolated rather than snapped so the user keeps their place
   * in the scene: a jump between opposite views is disorienting when you cannot
   * see how you got there.
   */
  const setView = (view: ViewName) => {
    const dist = Math.max(camera.position.distanceTo(controls.target), 40)
    const direction = new Vector3(...viewDirection(view))
    // A sketch keeps its plane's up axis, so asking for a standard view does not
    // tip the drawing sideways. In model space up is always world Z.
    if (session.sketchMode) {
      const frame = asWorkPlane(session.plane)
      camera.up.set(frame.u[0], frame.u[1], frame.u[2])
    } else {
      camera.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2])
    }
    const from = camera.position.clone()
    const to = controls.target.clone().addScaledVector(direction, dist)
    const target = controls.target.clone()
    const started = performance.now()
    const duration = 320
    if (viewAnim) cancelAnimationFrame(viewAnim)
    const step = () => {
      const t = Math.min(1, (performance.now() - started) / duration)
      // Ease out cubic: quick to start, settling at the end.
      const eased = 1 - (1 - t) ** 3
      camera.position.lerpVectors(from, to, eased)
      camera.lookAt(target)
      camera.updateProjectionMatrix()
      controls.update()
      if (t < 1) viewAnim = requestAnimationFrame(step)
      else viewAnim = 0
    }
    viewAnim = requestAnimationFrame(step)
  }

  const screenshot = () => {
    renderer.render(scene, camera)
    return renderer.domElement.toDataURL('image/png')
  }

  let frame = 0
  const loop = () => {
    frame = requestAnimationFrame(loop)
    // During a view animation the tween owns the camera. Letting damping update
    // as well would tug the camera back toward where the tween last left it.
    if (viewAnim === 0) controls.update()
    renderer.render(scene, camera)
    publishLabels()
  }
  resize()
  loop()

  return {
    clearSelection: () => setSelection([]),
    resize,
    setMeshes,
    setInteraction,
    cancelSketch,
    finishSketch,
    applyDraftDimension,
    applyEntityDimension,
    fit,
    lookAtSketch: () => {
      framePlane(session.plane)
    },
    lookAtPart: () => {
      frameModel()
      fit()
    },
    screenshot,
    setView,
    dispose() {
      cancelAnimationFrame(frame)
      if (viewAnim) cancelAnimationFrame(viewAnim)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      host.removeEventListener('pointerdown', onBoxStart, true)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      endBox()
      clearParts()
      clearGroup(sketchGroup)
      clearGroup(previewGroup)
      clearGroup(measureGroup)
      if (sketchGrid) {
        scene.remove(sketchGrid)
        sketchGrid.geometry.dispose()
        const material = sketchGrid.material
        if (Array.isArray(material)) for (const item of material) item.dispose()
      }
      lineMaterials.length = 0
      controls.dispose()
      renderer.dispose()
      renderer.domElement.remove()
    },
  }
}

function savePng(url: string) {
  const link = document.createElement('a')
  link.href = url
  link.download = 'cad-view.png'
  link.click()
}

/**
 * Orbit, grid, lights, and axes stay on when the scene is empty.
 * Click selects the active filter; Shift-click toggles the hit.
 * Delete and Undo stay on the parent.
 */
export const Viewport = forwardRef<
  ViewportHandle,
  {
    meshes: MeshBuffers[]
    selectedId?: string | null
    fitRequest?: number
    onPick?: (hit: PickHit | null) => void
    loading?: boolean
    loadingLabel?: string
    pickMode?: PickKind
    onSelectionChange?: (hits: PickHit[]) => void
    sketchMode?: boolean
    sketchTool?: SketchToolName
    plane?: PlaneArg
    sketchSnap?: number
    /** Side count for the polygon sketch tool. */
    polygonSides?: number
    /** Master object-snap switch from the status bar popover. */
    snapEnabled?: boolean
    /** Per-kind snap switches from the status bar popover. */
    snapSettings?: SnapSettings
    entities?: SketchEntity[]
    onSketchChange?: (entities: SketchEntity[]) => void
    onSketchPlaced?: (placed: number) => void
    /** A datum plane was clicked. */
    onPlanePick?: (plane: DatumPlane) => void
    onSketchFinish?: (entities: SketchEntity[]) => void
    measure?: MeasureVisual | null
  }
>(function Viewport(
  {
    meshes,
    selectedId = null,
    fitRequest = 0,
    onPick,
    onSelectionChange,
    loading = false,
    loadingLabel = 'Loading geometry…',
    pickMode = 'face',
    sketchMode = false,
    sketchTool = 'line',
    plane = 'XY',
    sketchSnap = 1,
    polygonSides = DEFAULT_POLYGON_SIDES,
    snapEnabled = true,
    snapSettings = DEFAULT_SNAP_SETTINGS,
    entities = NO_ENTITIES,
    onSketchChange,
    onSketchPlaced,
    onPlanePick,
    onSketchFinish,
    measure = null,
  },
  ref,
) {
  const hostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<SceneApi | null>(null)
  const hooksRef = useRef<SceneHooks>({
    onPick: () => {},
    onSelectionChange: () => {},
    onSketchChange: () => {},
    onSketchPlaced: () => {},
    onPlanePick: () => {},
    onSketchFinish: () => {},
    onLabels: () => {},
    onDraft: () => {},
  })
  const fitSeen = useRef(fitRequest)
  const labelKey = useRef('')
  const draftWasOn = useRef(false)
  const draftInput = useRef<HTMLInputElement>(null)
  const editInput = useRef<HTMLInputElement>(null)
  const [view, setViewName] = useState<ViewName>('iso')
  const [labels, setLabels] = useState<OverlayLabel[]>([])
  const [draftAnchor, setDraftAnchor] = useState<DraftAnchor | null>(null)
  const [draftText, setDraftText] = useState('')
  const [edit, setEdit] = useState<{ id: string; text: string } | null>(null)

  hooksRef.current.onPick = (hit) => onPick?.(hit)
  hooksRef.current.onSelectionChange = (hits) => onSelectionChange?.(hits)
  hooksRef.current.onSketchChange = (next) => onSketchChange?.(next)
  hooksRef.current.onSketchPlaced = (count) => onSketchPlaced?.(count)
  hooksRef.current.onPlanePick = (plane) => onPlanePick?.(plane)
  hooksRef.current.onSketchFinish = (next) => onSketchFinish?.(next)
  hooksRef.current.onLabels = (next) => {
    const key = next
      .map((label) => `${label.id}:${label.text}:${Math.round(label.x)}:${Math.round(label.y)}`)
      .join('|')
    if (key === labelKey.current) return
    labelKey.current = key
    setLabels(next)
  }
  hooksRef.current.onDraft = (next) => {
    setDraftAnchor((prev) => {
      if (!next) return prev ? null : prev
      const x = Math.round(next.x)
      const y = Math.round(next.y)
      if (
        prev &&
        prev.x === x &&
        prev.y === y &&
        prev.placeholder === next.placeholder &&
        prev.label === next.label
      ) {
        return prev
      }
      return { x, y, placeholder: next.placeholder, label: next.label }
    })
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = mountScene(host, {
      onPick: (hit) => hooksRef.current.onPick(hit),
      onSelectionChange: (hits) => hooksRef.current.onSelectionChange(hits),
      onSketchChange: (next) => hooksRef.current.onSketchChange(next),
      onSketchPlaced: (count) => hooksRef.current.onSketchPlaced(count),
      onPlanePick: (plane) => hooksRef.current.onPlanePick(plane),
      onSketchFinish: (next) => hooksRef.current.onSketchFinish(next),
      onLabels: (next) => hooksRef.current.onLabels(next),
      onDraft: (next) => hooksRef.current.onDraft(next),
    })
    apiRef.current = api
    const observer = new ResizeObserver(() => api.resize())
    observer.observe(host)
    return () => {
      observer.disconnect()
      api.dispose()
      apiRef.current = null
    }
  }, [])

  useEffect(() => {
    const api = apiRef.current
    if (!api) return
    api.setMeshes(meshes, selectedId)
    if (fitRequest !== fitSeen.current) {
      fitSeen.current = fitRequest
      api.fit()
    }
  }, [meshes, selectedId, fitRequest])

  useEffect(() => {
    apiRef.current?.setInteraction({
      sketchMode,
      sketchTool,
      plane,
      snap: sketchSnap,
      polygonSides,
      snapEnabled,
      snapSettings,
      pickMode,
      entities,
      measure,
    })
  }, [
    sketchMode,
    sketchTool,
    plane,
    sketchSnap,
    polygonSides,
    snapEnabled,
    snapSettings,
    pickMode,
    entities,
    measure,
  ])

  const applyView = (next: ViewName) => {
    apiRef.current?.setView(next)
    setViewName(next)
  }

  useImperativeHandle(
    ref,
    () => ({
      fit: () => apiRef.current?.fit(),
      finishSketch: () => apiRef.current?.finishSketch(),
      lookAtSketch: () => apiRef.current?.lookAtSketch(),
      lookAtPart: () => apiRef.current?.lookAtPart(),
      clearSelection: () => apiRef.current?.clearSelection(),
      screenshot: () => apiRef.current?.screenshot() ?? '',
      setView: applyView,
    }),
    [],
  )

  useEffect(() => {
    if (!draftAnchor) {
      draftWasOn.current = false
      setDraftText('')
      return
    }
    if (draftWasOn.current) return
    draftWasOn.current = true
    setDraftText('')
    draftInput.current?.focus()
  }, [draftAnchor])

  useEffect(() => {
    if (!edit) return
    editInput.current?.focus()
    editInput.current?.select()
  }, [edit?.id])

  const onDraftKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setDraftText('')
      apiRef.current?.cancelSketch()
      return
    }
    if (event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    const text = event.currentTarget.value
    if (!text.trim()) {
      apiRef.current?.finishSketch()
      return
    }
    if (apiRef.current?.applyDraftDimension(text)) setDraftText('')
  }

  const onEditKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setEdit(null)
      return
    }
    if (event.key !== 'Enter' || !edit) return
    event.preventDefault()
    event.stopPropagation()
    if (apiRef.current?.applyEntityDimension(edit.id, edit.text)) setEdit(null)
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (edit) {
        setEdit(null)
        return
      }
      setDraftText('')
      apiRef.current?.cancelSketch()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (edit) {
        if (apiRef.current?.applyEntityDimension(edit.id, edit.text)) setEdit(null)
        return
      }
      if (draftText.trim()) {
        if (apiRef.current?.applyDraftDimension(draftText)) setDraftText('')
        return
      }
      apiRef.current?.finishSketch()
      return
    }
    if (
      draftAnchor &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      event.key.length === 1 &&
      /[0-9.-]/.test(event.key)
    ) {
      event.preventDefault()
      setDraftText((value) => value + event.key)
      draftInput.current?.focus()
    }
  }

  const showEmpty = !loading && meshes.length === 0 && entities.length === 0 && !sketchMode
  const loneMeasure = Boolean(measure?.label && !(measure.a && measure.b))

  return (
    <div className="cad-viewport" tabIndex={0} aria-label="CAD viewport" onKeyDown={onKeyDown}>
      <div className="cad-viewport-stage" ref={hostRef} />
      {showEmpty ? <p className="cad-viewport-empty">Empty scene</p> : null}
      {loading ? (
        <div className="cad-loading" role="status">
          <span>{loadingLabel}</span>
        </div>
      ) : null}
      <SketchOverlay
        labels={labels}
        draft={draftAnchor ? { ...draftAnchor, text: draftText } : null}
        editId={edit?.id ?? null}
        editText={edit?.text ?? ''}
        draftRef={draftInput}
        editRef={editInput}
        onDraftText={setDraftText}
        onDraftKeyDown={onDraftKeyDown}
        onEdit={(label) => setEdit({ id: label.id, text: label.text })}
        onEditText={(text) => setEdit((current) => (current ? { ...current, text } : current))}
        onEditKeyDown={onEditKeyDown}
      />
      {loneMeasure ? <div className="cad-measure-readout">{measure?.label}</div> : null}
      <div className="cad-viewport-chrome">
        <ViewCube active={view} onView={applyView} />
        <div className="cad-viewport-actions">
          <button
            type="button"
            title="Look straight at the sketch plane"
            onClick={() => apiRef.current?.lookAtSketch()}
          >
            Sketch view
          </button>
          <button
            type="button"
            title="Return to the 3D view, framed on the part"
            onClick={() => apiRef.current?.lookAtPart()}
          >
            3D view
          </button>
          <button type="button" onClick={() => apiRef.current?.fit()}>
            Fit
          </button>
          <button
            type="button"
            onClick={() => {
              const url = apiRef.current?.screenshot()
              if (url) savePng(url)
            }}
          >
            Snapshot
          </button>
        </div>
      </div>
    </div>
  )
})
