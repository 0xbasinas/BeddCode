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
  EdgesGeometry,
  Float32BufferAttribute,
  GridHelper,
  Group,
  LineBasicMaterial,
  LineSegments,
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
  rankHits,
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
import type { SketchEntity } from './sketcher/types.ts'
import {
  advanceSketch,
  CAMERA_UP,
  DEFAULT_CAMERA_POSITION,
  edgePickThreshold,
  entityAnnotation,
  entityPolyline,
  formatLength,
  gridRotation,
  planeFrame,
  previewAnnotation,
  previewPolyline,
  projectRayToPlane,
  snapPoint,
  toWorld,
  viewDirection,
  worldDistance,
  type SketchPlaneName,
  type SketchToolName,
} from './sketcher/project.ts'
import { ViewCube, type ViewName } from './ViewCube.tsx'

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
 *   (`XY` floor, `YZ` right, `ZX` front), sketchSnap (millimetres; Shift flips 1 and 5),
 *   entities (sketcher entities, not the document params bag), onSketchChange, onSketchFinish
 * - measure: `{ a, b, label }` draws a distance between two world points
 * Delete and Undo belong to the parent. This view handles Escape (drop the open
 * sketch segment) and Enter (finish the sketch).
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
  /** PNG data URL of the WebGL canvas. */
  screenshot(): string
  setView(view: ViewName): void
}

const SOLID = 0x8d8d8d
const SOLID_SELECTED = 0xbdbdbd
const EDGE = 0x5c5c5c
const EDGE_HOVER = 0xb0b0b0
const SKETCH = 0x8a8a8a
const SKETCH_PREVIEW = 0xb4b4b4
const MEASURE = 0x9a9a9a
const HOVER = 0xcfcfcf
const SELECTED = 0xe0e0e0

interface SceneHooks {
  onPick(hit: PickHit | null): void
  onSelectionChange(hits: PickHit[]): void
  onSketchChange(entities: SketchEntity[]): void
  onSketchFinish(entities: SketchEntity[]): void
  onLabels(labels: OverlayLabel[]): void
}

interface SceneSession {
  sketchMode: boolean
  sketchTool: SketchToolName
  plane: SketchPlaneName
  snap: number
  pickMode: PickKind
  entities: SketchEntity[]
  measure: MeasureVisual | null
  placed: Array<[number, number]>
  cursor: [number, number] | null
}

interface SceneApi {
  resize(): void
  setMeshes(meshes: MeshBuffers[], selectedId: string | null): void
  setInteraction(next: Omit<SceneSession, 'placed' | 'cursor'>): void
  cancelSketch(): void
  finishSketch(): void
  fit(): void
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
  controls.update()

  scene.add(new AmbientLight(0xffffff, 0.7))
  const sun = new DirectionalLight(0xffffff, 1.15)
  sun.position.set(48, -56, 90)
  scene.add(sun)
  const ground = new GridHelper(200, 20, 0x3a3a3a, 0x2a2a2a)
  const floorTurn = gridRotation('XY')
  ground.rotation.set(floorTurn[0], floorTurn[1], floorTurn[2])
  scene.add(ground)
  scene.add(new AxesHelper(40))

  const parts = new Group()
  const hoverGroup = new Group()
  const selectGroup = new Group()
  const sketchGroup = new Group()
  const previewGroup = new Group()
  const measureGroup = new Group()
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
  let selection: SelectionItem[] = []
  let boxing = false
  let boxFrame: HTMLDivElement | null = null
  let boxFrom = { x: 0, y: 0 }

  type Found = HitCandidate & { object: Object3D; index: number; point: Vector3 }

  const session: SceneSession = {
    sketchMode: false,
    sketchTool: 'line',
    plane: 'XY',
    snap: 1,
    pickMode: 'face',
    entities: [],
    measure: null,
    placed: [],
    cursor: null,
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

  const lift = (plane: SketchPlaneName, x: number, y: number): [number, number, number] => {
    const world = toWorld(plane, x, y)
    const normal = planeFrame(plane).normal
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
    const polyline = previewPolyline(session.sketchTool, session.placed, session.cursor)
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

  const orientGrid = (grid: GridHelper, plane: SketchPlaneName) => {
    const turn = gridRotation(plane)
    grid.rotation.set(turn[0], turn[1], turn[2])
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
      const preview = previewAnnotation(session.sketchTool, session.placed, session.cursor)
      if (preview) {
        const screen = projectLabel(toWorld(session.plane, preview.at[0], preview.at[1]))
        if (screen) labels.push({ id: 'preview', text: preview.text, ...screen, kind: 'sketch' })
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
      const total = indexAttr ? indexAttr.count : (mesh.geometry.getAttribute('position')?.count ?? 0)
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

  /** Best hit under the cursor for the active filter, or null. */
  const findHit = (event: { clientX: number; clientY: number }): Found | null => {
    const ray = pointerRay(event)
    if (!ray) return null
    const box = renderer.domElement.getBoundingClientRect()
    const cx = event.clientX - box.left
    const cy = event.clientY - box.top
    const meshes = parts.children.filter((child) => child instanceof Mesh)
    const lines = parts.children.filter((child) => child instanceof LineSegments)
    const filter = session.pickMode
    const candidates: Found[] = []
    const face = raycaster.intersectObjects(meshes, false)[0]
    const faceDepth = face ? face.distance : Number.POSITIVE_INFINITY
    // Lines lying on a face tie with it, so allow a small slack before calling them hidden.
    const slack = camera.position.distanceTo(controls.target) * 0.01

    if (filter === 'face' && face?.object instanceof Mesh && face.faceIndex != null) {
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
    } else if (filter === 'edge') {
      const edge = raycaster.intersectObjects(lines, false)[0]
      if (edge?.object instanceof LineSegments && edge.index != null && edge.distance <= faceDepth + slack) {
        const line = edge.object
        const a = vertexAt(line, edge.index, new Vector3())
        const b = vertexAt(line, edge.index + 1, new Vector3())
        const sa = screenOf(a, box)
        const sb = screenOf(b, box)
        const range = edgeRanges(line).find(
          (entry) => edge.index! >= entry.start && edge.index! < entry.start + entry.count,
        )
        candidates.push({
          kind: 'edge',
          featureId: featureIdOf(line),
          id: range?.edgeId ?? edge.index,
          depth: edge.distance,
          screenPx: segmentDistancePx(cx, cy, sa.x, sa.y, sb.x, sb.y),
          object: line,
          index: range?.start ?? edge.index,
          point: edge.point,
        })
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
    const best = rankHits(candidates, filter)
    return best ? (best as Found) : null
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
    showHover(findHit(event))
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
    const found = findHit(event)
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

  const sketchCursor = (event: PointerEvent): [number, number] | null => {
    const ray = pointerRay(event)
    if (!ray) return null
    const hit = projectRayToPlane(
      [ray.origin.x, ray.origin.y, ray.origin.z],
      [ray.direction.x, ray.direction.y, ray.direction.z],
      session.plane,
    )
    if (!hit) return null
    const step = event.shiftKey ? (session.snap === 5 ? 1 : 5) : session.snap
    return snapPoint(hit, step > 0 ? step : 1)
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
    lastPointer = event
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
      session.cursor = sketchCursor(event)
      redrawPreview()
      return
    }
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
      const cursor = sketchCursor(event)
      if (!cursor) return
      session.cursor = cursor
      const next = advanceSketch(session.sketchTool, session.placed, cursor, `e${sketchSeq}`)
      session.placed = next.placed
      if (next.entity) {
        sketchSeq += 1
        session.entities = [...session.entities, next.entity]
        hooks.onSketchChange(session.entities)
        redrawCommitted()
      }
      redrawPreview()
      publishLabels()
      return
    }
    hooks.onPick(pick(event))
  }

  const onPointerLeave = () => {
    session.cursor = null
    if (session.sketchMode) redrawPreview()
    else clearHover()
  }

  host.addEventListener('pointerdown', onBoxStart, true)
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointermove', onPointerMove)
  renderer.domElement.addEventListener('pointerup', onPointerUp)
  renderer.domElement.addEventListener('pointerleave', onPointerLeave)

  const clearParts = () => {
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
          roughness: 0.62,
          metalness: 0.06,
          emissive: selected ? 0x2a2a2a : 0x000000,
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
      const edges = new LineSegments(edgeGeometry, new LineBasicMaterial({ color: EDGE }))
      edges.userData = { featureId: mesh.id, edgeGroups }
      parts.add(edges)
    }
    const before = selection.length
    selection = redrawSelection()
    if (selection.length !== before) hooks.onSelectionChange(selectionHits())
  }

  const setInteraction = (next: Omit<SceneSession, 'placed' | 'cursor'>) => {
    const resetDraft =
      next.sketchTool !== session.sketchTool ||
      next.plane !== session.plane ||
      next.sketchMode !== session.sketchMode
    session.sketchMode = next.sketchMode
    session.sketchTool = next.sketchTool
    session.plane = next.plane
    session.snap = next.snap
    if (next.pickMode !== session.pickMode) {
      session.pickMode = next.pickMode
      clearHover()
      setSelection(keepKind(selection, next.pickMode))
    }
    session.entities = next.entities
    session.measure = next.measure
    if (resetDraft) {
      session.placed = []
      session.cursor = null
    }
    renderer.domElement.style.cursor = session.sketchMode ? 'crosshair' : ''
    if (!session.sketchMode) clearHover()
    syncGrid()
    redrawCommitted()
    redrawPreview()
    redrawMeasure()
  }

  const cancelSketch = () => {
    session.placed = []
    session.cursor = null
    redrawPreview()
    publishLabels()
  }

  const finishSketch = () => {
    session.placed = []
    session.cursor = null
    redrawPreview()
    hooks.onSketchFinish(session.entities)
    publishLabels()
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
      const dist = (maxDim / 2 / Math.tan(Math.min(vertical, horizontal) / 2)) * 1.8
      controls.target.copy(center)
      camera.position.copy(center).addScaledVector(dir, dist)
      camera.near = Math.max(dist / 100, 0.01)
      camera.far = dist * 100
    }
    camera.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2])
    camera.updateProjectionMatrix()
    controls.update()
  }

  const setView = (view: ViewName) => {
    const dist = Math.max(camera.position.distanceTo(controls.target), 40)
    const direction = new Vector3(...viewDirection(view))
    camera.up.set(CAMERA_UP[0], CAMERA_UP[1], CAMERA_UP[2])
    camera.position.copy(controls.target).addScaledVector(direction, dist)
    camera.lookAt(controls.target)
    camera.updateProjectionMatrix()
    controls.update()
  }

  const screenshot = () => {
    renderer.render(scene, camera)
    return renderer.domElement.toDataURL('image/png')
  }

  let frame = 0
  const loop = () => {
    frame = requestAnimationFrame(loop)
    controls.update()
    renderer.render(scene, camera)
    publishLabels()
  }
  resize()
  loop()

  return {
    resize,
    setMeshes,
    setInteraction,
    cancelSketch,
    finishSketch,
    fit,
    screenshot,
    setView,
    dispose() {
      cancelAnimationFrame(frame)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      host.removeEventListener('pointerdown', onBoxStart, true)
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
 * Face picks are a click. Edge picks are shift-click, or every click in edge mode.
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
    plane?: SketchPlaneName
    sketchSnap?: number
    entities?: SketchEntity[]
    onSketchChange?: (entities: SketchEntity[]) => void
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
    entities = NO_ENTITIES,
    onSketchChange,
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
    onSketchFinish: () => {},
    onLabels: () => {},
  })
  const fitSeen = useRef(fitRequest)
  const labelKey = useRef('')
  const [view, setViewName] = useState<ViewName>('iso')
  const [labels, setLabels] = useState<OverlayLabel[]>([])

  hooksRef.current.onPick = (hit) => onPick?.(hit)
  hooksRef.current.onSelectionChange = (hits) => onSelectionChange?.(hits)
  hooksRef.current.onSketchChange = (next) => onSketchChange?.(next)
  hooksRef.current.onSketchFinish = (next) => onSketchFinish?.(next)
  hooksRef.current.onLabels = (next) => {
    const key = next
      .map((label) => `${label.id}:${label.text}:${Math.round(label.x)}:${Math.round(label.y)}`)
      .join('|')
    if (key === labelKey.current) return
    labelKey.current = key
    setLabels(next)
  }

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = mountScene(host, {
      onPick: (hit) => hooksRef.current.onPick(hit),
      onSelectionChange: (hits) => hooksRef.current.onSelectionChange(hits),
      onSketchChange: (next) => hooksRef.current.onSketchChange(next),
      onSketchFinish: (next) => hooksRef.current.onSketchFinish(next),
      onLabels: (next) => hooksRef.current.onLabels(next),
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
      pickMode,
      entities,
      measure,
    })
  }, [sketchMode, sketchTool, plane, sketchSnap, pickMode, entities, measure])

  const applyView = (next: ViewName) => {
    apiRef.current?.setView(next)
    setViewName(next)
  }

  useImperativeHandle(
    ref,
    () => ({
      fit: () => apiRef.current?.fit(),
      screenshot: () => apiRef.current?.screenshot() ?? '',
      setView: applyView,
    }),
    [],
  )

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      apiRef.current?.cancelSketch()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      apiRef.current?.finishSketch()
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
      <SketchOverlay labels={labels} />
      {loneMeasure ? <div className="cad-measure-readout">{measure?.label}</div> : null}
      <div className="cad-viewport-chrome">
        <ViewCube active={view} onView={applyView} />
        <div className="cad-viewport-actions">
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
