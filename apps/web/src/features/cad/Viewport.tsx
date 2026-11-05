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
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PerspectiveCamera,
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
import { edgeAt, faceAt } from './solids.ts'
import { SketchOverlay, type OverlayLabel } from './SketchOverlay.tsx'
import { applyDimensionToEntity, commitLiveDimension } from './sketcher/dimension.ts'
import {
  advanceSketch,
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
  gridStepForShift,
  resolveSnap,
  sketchSnapTolerance,
  snapCaption,
  type SnapKind,
} from './sketcher/snap.ts'
import type { SketchEntity } from './sketcher/types.ts'
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
 * - pickMode: `'face'` (default) or `'edge'`. Shift-click still picks an edge.
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

/** A face or edge the raycaster hit. Edge picks are shift-click or `pickMode: 'edge'`. */
export interface PickHit {
  kind: 'face' | 'edge'
  featureId: string
  /** Triangle index, or the edge segment's first vertex when `kind` is `edge`. */
  index: number
  faceId?: number
  edgeId?: number
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

interface DraftAnchor {
  x: number
  y: number
  placeholder: string
  label: string
}

interface SceneHooks {
  onPick(hit: PickHit | null): void
  onSketchChange(entities: SketchEntity[]): void
  onSketchFinish(entities: SketchEntity[]): void
  onLabels(labels: OverlayLabel[]): void
  onDraft(draft: DraftAnchor | null): void
}

interface SceneSession {
  sketchMode: boolean
  sketchTool: SketchToolName
  plane: PlaneArg
  snap: number
  pickMode: 'face' | 'edge'
  entities: SketchEntity[]
  measure: MeasureVisual | null
  placed: Array<[number, number]>
  cursor: [number, number] | null
  snapKind: SnapKind | null
}

interface SceneApi {
  resize(): void
  setMeshes(meshes: MeshBuffers[], selectedId: string | null): void
  setInteraction(next: Omit<SceneSession, 'placed' | 'cursor' | 'snapKind'>): void
  cancelSketch(): void
  finishSketch(): void
  applyDraftDimension(text: string): boolean
  applyEntityDimension(id: string, text: string): boolean
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
  const sketchGroup = new Group()
  const previewGroup = new Group()
  const measureGroup = new Group()
  scene.add(parts)
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

  const orientGrid = (grid: GridHelper, plane: PlaneArg) => {
    const frame = asWorkPlane(plane)
    grid.position.set(frame.origin[0], frame.origin[1], frame.origin[2])
    gridX.set(frame.u[0], frame.u[1], frame.u[2])
    gridY.set(frame.normal[0], frame.normal[1], frame.normal[2])
    gridZ.crossVectors(gridX, gridY)
    if (gridZ.lengthSq() < 1e-8) return
    grid.quaternion.setFromRotationMatrix(gridBasis.makeBasis(gridX, gridY, gridZ))
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
    const note = previewAnnotation(session.sketchTool, session.placed, session.cursor)
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
        const preview = previewAnnotation(session.sketchTool, session.placed, session.cursor)
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

  const showFaceHover = (mesh: Mesh, triangleIndex: number) => {
    const groups = mesh.userData.faceGroups as FaceGroup[] | undefined
    const key = `${featureIdOf(mesh)}:f:${triangleIndex}:${groups?.length ?? 0}`
    if (key === hoverKey) return
    clearHover()
    hoverKey = key
    const geometry = faceGeometry(mesh.geometry, triangleIndex, groups)
    if (!geometry) return
    const overlay = new Mesh(
      geometry,
      new MeshBasicMaterial({
        color: HOVER,
        transparent: true,
        opacity: 0.42,
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
    hoverGroup.add(overlay)
  }

  const showEdgeHover = (line: LineSegments, vertexIndex: number) => {
    const groups = line.userData.edgeGroups as EdgeGroup[] | undefined
    const position = line.geometry.getAttribute('position')
    if (!position) return
    const found = edgeAt(groups, vertexIndex, position.count)
    const start = found?.start ?? vertexIndex
    const count = found?.count ?? 2
    const key = `${featureIdOf(line)}:e:${start}:${count}`
    if (key === hoverKey) return
    clearHover()
    hoverKey = key
    const positions: number[] = []
    const end = Math.min(position.count, start + count)
    for (let vertex = start; vertex < end; vertex++) {
      positions.push(position.getX(vertex), position.getY(vertex), position.getZ(vertex))
    }
    if (positions.length < 6) return
    const geometry = new BufferGeometry()
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
    const highlight = new LineSegments(
      geometry,
      new LineBasicMaterial({
        color: EDGE_HOVER,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    )
    highlight.raycast = () => {}
    hoverGroup.add(highlight)
  }

  const pointerRay = (event: { clientX: number; clientY: number }) => {
    const rect = renderer.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    const distance = camera.position.distanceTo(controls.target)
    raycaster.params.Line.threshold = edgePickThreshold(distance)
    raycaster.setFromCamera(pointer, camera)
    return raycaster.ray
  }

  const hoverAt = (event: PointerEvent) => {
    if (session.sketchMode) {
      clearHover()
      return
    }
    const ray = pointerRay(event)
    if (!ray) return
    const meshes = parts.children.filter((child) => child instanceof Mesh)
    const edges = parts.children.filter((child) => child instanceof LineSegments)
    const wantEdge = event.shiftKey || session.pickMode === 'edge'
    if (wantEdge) {
      const edge = raycaster.intersectObjects(edges, false)[0]
      if (edge?.object instanceof LineSegments && edge.index != null) {
        showEdgeHover(edge.object, edge.index)
        return
      }
      clearHover()
      return
    }
    const face = raycaster.intersectObjects(meshes, false)[0]
    if (face?.object instanceof Mesh && face.faceIndex != null) {
      showFaceHover(face.object, face.faceIndex)
      return
    }
    clearHover()
  }

  const pick = (event: PointerEvent): PickHit | null => {
    if (!pointerRay(event)) return null
    const meshes = parts.children.filter((child) => child instanceof Mesh)
    const edges = parts.children.filter((child) => child instanceof LineSegments)
    const face = raycaster.intersectObjects(meshes, false)[0]
    const edge = raycaster.intersectObjects(edges, false)[0]
    const wantEdge = event.shiftKey || session.pickMode === 'edge'
    if (wantEdge && edge) {
      const groups = edge.object.userData.edgeGroups as EdgeGroup[] | undefined
      const position = (edge.object as LineSegments).geometry.getAttribute('position')
      const vertexIndex = edge.index ?? 0
      const found = edgeAt(groups, vertexIndex, position?.count ?? 0)
      const hit: PickHit = {
        kind: 'edge',
        featureId: featureIdOf(edge.object),
        index: vertexIndex,
        point: pointTuple(edge.point),
      }
      if (found) hit.edgeId = found.edgeId
      return hit
    }
    if (!wantEdge && face) {
      const groups = face.object.userData.faceGroups as FaceGroup[] | undefined
      const indexAttr = (face.object as Mesh).geometry.getIndex()
      const position = (face.object as Mesh).geometry.getAttribute('position')
      const indexCount = indexAttr ? indexAttr.count : (position?.count ?? 0)
      const triangleIndex = face.faceIndex ?? 0
      const found = faceAt(groups, triangleIndex, indexCount)
      const hit: PickHit = {
        kind: 'face',
        featureId: featureIdOf(face.object),
        index: triangleIndex,
        point: pointTuple(face.point),
      }
      if (found) hit.faceId = found.faceId
      return hit
    }
    if (edge) {
      const hit: PickHit = {
        kind: 'edge',
        featureId: featureIdOf(edge.object),
        index: edge.index ?? 0,
        point: pointTuple(edge.point),
      }
      return hit
    }
    return null
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
    })
  }

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) return
    down = true
    downX = event.clientX
    downY = event.clientY
    host.parentElement?.focus({ preventScroll: true })
  }

  const onPointerMove = (event: PointerEvent) => {
    lastPointer = event
    if (session.sketchMode) {
      const snap = sketchCursor(event)
      session.cursor = snap?.point ?? null
      session.snapKind = snap?.kind ?? null
      redrawPreview()
      return
    }
    hoverAt(event)
  }

  const onPointerUp = (event: PointerEvent) => {
    if (!down || event.button !== 0) return
    down = false
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > 4) return
    if (session.sketchMode) {
      const snap = sketchCursor(event)
      if (!snap) return
      session.cursor = snap.point
      session.snapKind = snap.kind
      const next = advanceSketch(session.sketchTool, session.placed, snap.point, `e${sketchSeq}`)
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
    session.snapKind = null
    if (session.sketchMode) redrawPreview()
    else clearHover()
  }

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Shift' || !lastPointer) return
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
    hoverAt(lastPointer)
  }

  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointermove', onPointerMove)
  renderer.domElement.addEventListener('pointerup', onPointerUp)
  renderer.domElement.addEventListener('pointerleave', onPointerLeave)
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)

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
  }

  const setInteraction = (next: Omit<SceneSession, 'placed' | 'cursor' | 'snapKind'>) => {
    const resetDraft =
      next.sketchTool !== session.sketchTool ||
      planeKey(next.plane) !== planeKey(session.plane) ||
      next.sketchMode !== session.sketchMode
    session.sketchMode = next.sketchMode
    session.sketchTool = next.sketchTool
    session.plane = next.plane
    session.snap = next.snap
    session.pickMode = next.pickMode
    session.entities = next.entities
    session.measure = next.measure
    if (resetDraft) {
      session.placed = []
      session.cursor = null
      session.snapKind = null
    }
    renderer.domElement.style.cursor = session.sketchMode ? 'crosshair' : ''
    if (!session.sketchMode) clearHover()
    syncGrid()
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
    applyDraftDimension,
    applyEntityDimension,
    fit,
    screenshot,
    setView,
    dispose() {
      cancelAnimationFrame(frame)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointermove', onPointerMove)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
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
    pickMode?: 'face' | 'edge'
    sketchMode?: boolean
    sketchTool?: SketchToolName
    plane?: PlaneArg
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
    onSketchChange: () => {},
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
      onSketchChange: (next) => hooksRef.current.onSketchChange(next),
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
