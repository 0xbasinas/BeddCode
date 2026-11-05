import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
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
  MeshStandardMaterial,
  PerspectiveCamera,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import type { MeshBuffers } from './solids.ts'
import { ViewCube, type ViewName } from './ViewCube.tsx'

export type { MeshBuffers } from './solids.ts'
export type { ViewName } from './ViewCube.tsx'

/** A face or edge the raycaster hit. Edge picks are the shift-click path. */
export interface PickHit {
  kind: 'face' | 'edge'
  featureId: string
  index: number
}

export interface ViewportHandle {
  fit(): void
  screenshot(): string
  setView(view: ViewName): void
}

interface SceneApi {
  resize(): void
  setMeshes(meshes: MeshBuffers[], selectedId: string | null): void
  fit(): void
  screenshot(): string
  setView(view: ViewName): void
  dispose(): void
}

function mountScene(host: HTMLElement, onPick: (hit: PickHit | null) => void): SceneApi {
  const scene = new Scene()
  const camera = new PerspectiveCamera(45, 1, 0.1, 5000)
  camera.position.set(90, 70, 90)
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
  sun.position.set(40, 80, 30)
  scene.add(sun)
  scene.add(new GridHelper(200, 20, 0x3a3a3a, 0x2a2a2a))
  scene.add(new AxesHelper(40))

  const parts = new Group()
  scene.add(parts)

  const raycaster = new Raycaster()
  raycaster.params.Line.threshold = 0.6
  const pointer = new Vector2()
  let downX = 0
  let downY = 0
  let down = false

  const featureIdOf = (object: { userData: Record<string, unknown> }) =>
    typeof object.userData.featureId === 'string' ? object.userData.featureId : ''

  const pick = (event: PointerEvent): PickHit | null => {
    const rect = renderer.domElement.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) return null
    pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1
    pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1
    raycaster.setFromCamera(pointer, camera)
    const meshes = parts.children.filter((child) => child instanceof Mesh)
    const edges = parts.children.filter((child) => child instanceof LineSegments)
    const face = raycaster.intersectObjects(meshes, false)[0]
    const edge = raycaster.intersectObjects(edges, false)[0]
    if (event.shiftKey && edge) {
      return { kind: 'edge', featureId: featureIdOf(edge.object), index: edge.index ?? 0 }
    }
    if (face) {
      return { kind: 'face', featureId: featureIdOf(face.object), index: face.faceIndex ?? 0 }
    }
    if (edge) {
      return { kind: 'edge', featureId: featureIdOf(edge.object), index: edge.index ?? 0 }
    }
    return null
  }

  const onPointerDown = (event: PointerEvent) => {
    down = true
    downX = event.clientX
    downY = event.clientY
  }
  const onPointerUp = (event: PointerEvent) => {
    if (!down) return
    down = false
    if (Math.hypot(event.clientX - downX, event.clientY - downY) > 4) return
    onPick(pick(event))
  }
  renderer.domElement.addEventListener('pointerdown', onPointerDown)
  renderer.domElement.addEventListener('pointerup', onPointerUp)

  const resize = () => {
    const width = host.clientWidth
    const height = host.clientHeight
    if (width === 0 || height === 0) return
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
  }

  const clearParts = () => {
    for (const child of parts.children) {
      if (!(child instanceof Mesh) && !(child instanceof LineSegments)) continue
      child.geometry.dispose()
      const material = child.material
      if (Array.isArray(material)) for (const item of material) item.dispose()
      else material.dispose()
    }
    parts.clear()
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
      const selected = mesh.id === selectedId
      const solid = new Mesh(
        geometry,
        new MeshStandardMaterial({
          color: selected ? 0xbdbdbd : 0x8d8d8d,
          roughness: 0.62,
          metalness: 0.06,
          emissive: selected ? 0x2a2a2a : 0x000000,
        }),
      )
      solid.userData = { featureId: mesh.id }
      parts.add(solid)
      const edges = new LineSegments(
        new EdgesGeometry(geometry),
        new LineBasicMaterial({ color: 0x5c5c5c }),
      )
      edges.userData = { featureId: mesh.id }
      parts.add(edges)
    }
  }

  const fit = () => {
    const box = new Box3()
    for (const child of parts.children) {
      if (child instanceof Mesh) box.expandByObject(child)
    }
    const dir = camera.position.clone().sub(controls.target)
    if (dir.lengthSq() < 1e-6) dir.set(1, 0.8, 1)
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
    camera.updateProjectionMatrix()
    controls.update()
  }

  const setView = (view: ViewName) => {
    const dist = Math.max(camera.position.distanceTo(controls.target), 40)
    const direction = new Vector3()
    if (view === 'front') direction.set(0, 0, 1)
    else if (view === 'top') direction.set(0, 1, 0)
    else if (view === 'right') direction.set(1, 0, 0)
    else direction.set(1, 0.8, 1)
    direction.normalize()
    camera.up.set(0, view === 'top' ? 0 : 1, view === 'top' ? -1 : 0)
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
  }
  resize()
  loop()

  return {
    resize,
    setMeshes,
    fit,
    screenshot,
    setView,
    dispose() {
      cancelAnimationFrame(frame)
      renderer.domElement.removeEventListener('pointerdown', onPointerDown)
      renderer.domElement.removeEventListener('pointerup', onPointerUp)
      clearParts()
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
 * Empty three.js view until mesh buffers arrive. Orbit, grid, lights, and axes
 * are always on. Face picks are a click; edge picks are shift-click.
 */
export const Viewport = forwardRef<
  ViewportHandle,
  {
    meshes: MeshBuffers[]
    selectedId?: string | null
    fitRequest?: number
    onPick?: (hit: PickHit | null) => void
  }
>(function Viewport({ meshes, selectedId = null, fitRequest = 0, onPick }, ref) {
  const hostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<SceneApi | null>(null)
  const onPickRef = useRef(onPick)
  const fitSeen = useRef(fitRequest)
  const [view, setViewName] = useState<ViewName>('iso')
  onPickRef.current = onPick

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = mountScene(host, (hit) => onPickRef.current?.(hit))
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

  return (
    <div className="cad-viewport" ref={hostRef}>
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
