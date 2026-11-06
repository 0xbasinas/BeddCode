import { Redo2, Undo2 } from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useHostKey } from '../../stores/HostScope.tsx'
import { reportCadView } from '../../stores/host.ts'
import {
  setCadPaneOpen,
  registerCadExportProvider,
  registerCadImportProvider,
  registerCadQueryProvider,
  registerCadRebuildProvider,
  registerCadScreenshotProvider,
  setCadView,
  decodeTransferBytes,
  decodeTransferText,
  type CadExportRequest,
  type CadImportRequest,
  type CadQueryRequest,
  type CadRebuildRequest,
} from './cadHostBridge.ts'
import { FeatureTree } from './FeatureTree.tsx'
import { PropertiesPanel, type PlacementField } from './PropertiesPanel.tsx'
import { PICK_KINDS, type PickKind } from './selection.ts'
import { faceAt, type MeshBuffers } from './solids.ts'
import {
  Toolbar,
  DEFAULT_TOOL_OPTIONS,
  draftParamPatch,
  draftWriteMode,
  pulldownFor,
  toolStatusHint,
  type CadTool,
  type SketchTool,
  type SketchPlaneName,
  type ToolOptions,
} from './Toolbar.tsx'
import { Viewport, type PickHit, type ViewportHandle } from './Viewport.tsx'
import { planeFromFace } from './sketcher/facePlane.ts'
import { workPlaneFromNormal, type PlaneArg } from './sketcher/project.ts'
import { mergeEdgeParams, signatureForEdge } from './edgeRefs.ts'
import { faceFrameFromMesh } from './kernel/featureOps.ts'
import {
  addHoleFromFace,
  appendFeature,
  emptyDocument,
  isCadDocument,
  isSolidFeature,
  makeBooleanFeature,
  makeBoxFeature,
  makeChamferFeature,
  makeCylinderFeature,
  makeExtrudeFeature,
  makeFilletFeature,
  makeImportFeature,
  makeRevolveFeature,
  makeSphereFeature,
  moveFeature,
  openFaceSketch,
  removeFeature,
  setSketchEntities,
  updateFeature,
  type CadDocument,
  type CadFeature,
  type CadSketch,
  type FaceSketchPlacement,
} from './model/CadDocument.ts'
import { UndoStack } from './model/undo.ts'
import type { SketchEntity as DrawnEntity } from './sketcher/types.ts'
import { useCadRebuild } from './useCadRebuild.ts'
import { NumericFlyout, type FlyoutAnchor } from './flyout/NumericFlyout.tsx'
import { quickFieldAsInput, quickFieldFor } from './flyout/quickField.ts'
import {
  acceptInput,
  startSteps,
  stepForPlaced,
  stepProgress,
  type StepInput,
  type StepState,
} from './steps/steps.ts'
import { stepsFor } from './steps/toolSteps.ts'
import { DEFAULT_SNAP_CONFIG, SnapMenu, type SnapConfig } from './SnapMenu.tsx'
import { addAnnotation, pruneAnnotations, removeAnnotation, type Annotation } from './annotations.ts'
import { AnnotationCards } from './AnnotationCards.tsx'
import './cad.css'

function placementFromHit(
  hit: PickHit,
  meshes: readonly MeshBuffers[],
): FaceSketchPlacement | null {
  if (hit.kind !== 'face') return null
  const mesh = meshes.find((item) => item.id === hit.featureId)
  if (!mesh) return null
  const indexCount = mesh.indices ? mesh.indices.length : mesh.positions.length / 3
  const found = faceAt(mesh.faceGroups, hit.index, indexCount)
  const solved = planeFromFace({
    positions: mesh.positions,
    indices: mesh.indices,
    normals: mesh.normals,
    ...(found ? { triangles: found.triangles } : { triangleIndex: hit.index }),
  })
  if (!solved) return null
  const faceId = hit.faceId ?? found?.faceId
  if (solved.kind === 'named') {
    return {
      plane: solved.plane,
      hostId: hit.featureId,
      ...(faceId !== undefined ? { faceId } : {}),
    }
  }
  return {
    plane: solved.plane,
    origin: solved.origin,
    normal: solved.normal,
    hostId: hit.featureId,
    ...(faceId !== undefined ? { faceId } : {}),
  }
}

function placementWhere(placement: FaceSketchPlacement): string {
  return placement.origin ? 'face' : placement.plane
}

/**
 * CAD pane: toolbar, feature tree, viewport, properties, and a status bar.
 * The arrangement follows a common solid modeler. It does not share code with the AGPL reference CAD.
 * Solids are rebuilt through createCadClient() and OpenCascade.
 *
 */
export function CadPane() {
  const hostKey = useHostKey()
  const stack = useRef(new UndoStack(emptyDocument()))
  const viewport = useRef<ViewportHandle>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const paneRef = useRef<HTMLDivElement>(null)
  const fitArmed = useRef(false)
  const [doc, setDoc] = useState<CadDocument>(() => stack.current.current())
  const [stepFiles, setStepFiles] = useState<Record<string, Uint8Array>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previousId, setPreviousId] = useState<string | null>(null)
  const [tool, setTool] = useState<CadTool>('select')
  const [message, setMessage] = useState(() => toolStatusHint('select'))
  const [options, setOptions] = useState<ToolOptions>(DEFAULT_TOOL_OPTIONS)
  const [fitRequest, setFitRequest] = useState(0)
  const [pick, setPick] = useState<PickHit | null>(null)
  const [pickedEdges, setPickedEdges] = useState<PickHit[]>([])
  const [pickFilter, setPickFilter] = useState<PickKind>('face')
  const forcedEdge = tool === 'fillet' || tool === 'chamfer'
  const activeFilter: PickKind = forcedEdge ? 'edge' : pickFilter
  const [activeSketchId, setActiveSketchId] = useState<string | null>(null)
  const [activePlane, setActivePlane] = useState<CadSketch['plane']>('XY')
  const [sketchTool, setSketchTool] = useState<SketchTool>('rectangle')
  /** Measurements pinned in the viewport. They outlive a single pick. */
  const [annotations, setAnnotations] = useState<readonly Annotation[]>([])
  const [holeDepth, setHoleDepth] = useState(10)
  /** Open numeric box. `null` keeps it shut; the anchor places it in the viewport. */
  const [flyoutAnchor, setFlyoutAnchor] = useState<FlyoutAnchor | null>(null)
  /** Set while a drag feeds the box so it reads as a live value. */
  const [flyoutValue, setFlyoutValue] = useState<number | null>(null)
  /** Digit that opened the box, kept as the first character typed. */
  const [flyoutSeed, setFlyoutSeed] = useState('')
  /** Position in the active tool's pick sequence. */
  const [steps, setSteps] = useState<StepState>(() => startSteps([]))
  /** Object-snap switches, shown in the status bar while sketching. */
  const [snapConfig, setSnapConfig] = useState<SnapConfig>(DEFAULT_SNAP_CONFIG)
  /** Which tool each pulldown last ran, so its face stays where the user left it. */
  const [lastUsed, setLastUsed] = useState<Record<string, CadTool>>({})
  /**
   * A feature shown but not committed.
   *
   * Extrude and revolve are the operations where a blind commit hurts most: you
   * cannot tell how deep it went until you are looking at a wrong solid. The
   * preview document is rebuilt and drawn, and only becomes real on confirm.
   */
  const [previewFeature, setPreviewFeature] = useState<CadFeature | null>(null)
  const optionsRef = useRef(options)
  const draftRef = useRef<string | null>(null)
  const draftTimer = useRef<number | null>(null)
  const activeSketchRef = useRef<string | null>(null)
  optionsRef.current = options
  activeSketchRef.current = activeSketchId

  // The preview is drawn by rebuilding a document that includes it, while the
  // undo stack still holds the committed one.
  const builtDoc = useMemo(
    () => (previewFeature ? appendFeature(doc, previewFeature) : doc),
    [doc, previewFeature],
  )
  const { meshes, errors, loading, failure, getClient } = useCadRebuild(builtDoc, stepFiles)
  const docRef = useRef(doc)
  const meshesRef = useRef(meshes)
  const selectedRef = useRef(selectedId)
  const getClientRef = useRef(getClient)
  docRef.current = doc
  meshesRef.current = meshes
  selectedRef.current = selectedId
  getClientRef.current = getClient
  const meshKey = meshes.map((mesh) => mesh.id).join('|')

  useEffect(() => {
    if (!fitArmed.current || loading) return
    fitArmed.current = false
    setFitRequest((value) => value + 1)
  }, [meshKey, loading])

  useEffect(() => {
    return () => {
      if (draftTimer.current !== null) window.clearTimeout(draftTimer.current)
    }
  }, [])

  useEffect(() => {
    const selection = selectedId ? [selectedId] : []
    setCadView({ canRender: true, documentId: doc.id, selection })
    reportCadView(hostKey, { documentId: doc.id, selection })
  }, [hostKey, doc.id, selectedId])

  useEffect(() => {
    setCadPaneOpen(true)
    return () => {
      setCadPaneOpen(false)
      setCadView({ canRender: false, selection: [] })
      reportCadView(hostKey, null)
    }
  }, [hostKey])

  useEffect(() => {
    const shapeId = (): string | null => {
      const current = docRef.current
      const selected = current.features.find((feature) => feature.id === selectedRef.current)
      if (selected && isSolidFeature(selected)) return selected.id
      const meshesNow = meshesRef.current
      return meshesNow[meshesNow.length - 1]?.id ?? null
    }
    const applyDocument = (next: CadDocument) => {
      stack.current.push(next)
      const saved = stack.current.current()
      docRef.current = saved
      setDoc(saved)
      setMessage('Rebuilt from the host')
      fitArmed.current = true
    }
    const stopShot = registerCadScreenshotProvider(() => viewport.current?.screenshot() ?? '')
    const stopExport = registerCadExportProvider(async (request: CadExportRequest) => {
      const format = request.format.trim().toLowerCase()
      const current = docRef.current
      const id =
        request.featureId && current.features.some((feature) => feature.id === request.featureId)
          ? request.featureId
          : shapeId()
      if (format === 'json') return JSON.stringify(current)
      if (!id) throw new Error('Select a solid to export')
      const client = getClientRef.current()
      if (format === 'step' || format === 'stp') return client.exportStep(id)
      if (format === 'stl') return client.exportStl(id)
      throw new Error(`Unknown export format ${request.format}`)
    })
    const stopQuery = registerCadQueryProvider(async (request: CadQueryRequest) => {
      const id = request.featureId ?? shapeId()
      if (!id) throw new Error('Select a solid to measure')
      return getClientRef.current().measure(id)
    })
    const stopRebuild = registerCadRebuildProvider(async (request: CadRebuildRequest) => {
      if (request.document === undefined) return
      if (!isCadDocument(request.document)) throw new Error('That document is not a CAD part')
      applyDocument(request.document)
    })
    const stopImport = registerCadImportProvider(async (request: CadImportRequest) => {
      const format = request.format.trim().toLowerCase()
      if (format === 'json') {
        const parsed: unknown = JSON.parse(decodeTransferText(request.data))
        if (!isCadDocument(parsed)) throw new Error('That file is not a CAD document')
        applyDocument(parsed)
        return { features: parsed.features, sketches: parsed.sketches }
      }
      if (format === 'step' || format === 'stp') {
        const bytes = decodeTransferBytes(request.data)
        const current = docRef.current
        const feature = makeImportFeature(current, request.filename ?? 'import.step')
        setStepFiles((files) => ({ ...files, [feature.id]: bytes }))
        applyDocument(appendFeature(current, feature))
        return { features: [feature], sketches: [] }
      }
      throw new Error(`Cannot import ${request.format} in the pane`)
    })
    return () => {
      stopShot()
      stopExport()
      stopQuery()
      stopRebuild()
      stopImport()
    }
  }, [hostKey])

  const commit = (next: CadDocument) => {
    if (next === docRef.current) return
    stack.current.push(next)
    const saved = stack.current.current()
    docRef.current = saved
    setDoc(saved)
    // A deleted feature takes its measurement with it.
    const live = new Set(saved.features.map((feature) => feature.id))
    setAnnotations((list) => pruneAnnotations(list, live))
  }

  const clearDraftTimer = () => {
    if (draftTimer.current === null) return
    window.clearTimeout(draftTimer.current)
    draftTimer.current = null
  }

  /** Writes strip values onto the feature created by the active tool, not an older selection. */
  const applyDraft = () => {
    const id = draftRef.current
    if (!id) return
    const current = docRef.current
    const feature = current.features.find((item) => item.id === id)
    if (!feature) return
    const raw = draftParamPatch(feature.kind, optionsRef.current)
    if (!raw) return
    const patch = { ...raw }
    if (
      feature.kind === 'hole' &&
      patch.throughAll === false &&
      typeof feature.params.depth !== 'number'
    ) {
      patch.depth = 10
    }
    const same = Object.entries(patch).every(([key, value]) => feature.params[key] === value)
    if (same) return
    commit(updateFeature(current, id, { params: patch }))
  }

  const onOptionsChange = (patch: Partial<ToolOptions>) => {
    const next = { ...optionsRef.current, ...patch }
    optionsRef.current = next
    setOptions(next)
    // A live preview follows the distance rather than needing a re-arm.
    const distance = patch.extrudeDistance
    if (previewFeature && distance !== undefined) {
      setPreviewFeature((feature) =>
        feature ? { ...feature, params: { ...feature.params, distance } } : feature,
      )
    }
    if (patch.sketchPlane) {
      setActivePlane(patch.sketchPlane)
      const sketchId = activeSketchRef.current
      if (sketchId) commit(withSketchPlane(docRef.current, sketchId, patch.sketchPlane))
    }
    const mode = draftWriteMode(patch)
    if (mode === 'none') return
    clearDraftTimer()
    if (mode === 'now') {
      applyDraft()
      return
    }
    draftTimer.current = window.setTimeout(() => {
      draftTimer.current = null
      applyDraft()
    }, 320)
  }

  const undo = () => {
    clearDraftTimer()
    draftRef.current = null
    const saved = stack.current.undo()
    docRef.current = saved
    setDoc(saved)
  }
  const redo = () => {
    clearDraftTimer()
    draftRef.current = null
    const saved = stack.current.redo()
    docRef.current = saved
    setDoc(saved)
  }

  const choose = (id: string | null) => {
    if (id && selectedId && id !== selectedId) setPreviousId(selectedId)
    if (id !== draftRef.current) {
      clearDraftTimer()
      draftRef.current = null
    }
    setSelectedId(id)
  }

  const rememberFit = () => {
    fitArmed.current = true
  }

  const selected = doc.features.find((feature) => feature.id === selectedId) ?? null
  const activeSketch =
    doc.sketches.find((sketch) => sketch.id === activeSketchId) ??
    (selected?.kind === 'sketch'
      ? doc.sketches.find((sketch) => sketch.id === selected.id)
      : undefined)
  const activeSketchEntities = (activeSketch?.entities ?? []) as unknown as DrawnEntity[]
  const drawingPlane = useMemo<PlaneArg>(() => {
    if (activeSketch?.origin && activeSketch.normal) {
      return workPlaneFromNormal(activeSketch.origin, activeSketch.normal)
    }
    return activePlane
  }, [activeSketch?.origin, activeSketch?.normal, activePlane])

  /** Turn the preview into a real feature: one undo step. */
  const confirmPreview = () => {
    const feature = previewFeature
    if (!feature) return
    setPreviewFeature(null)
    addSolid(feature, 'select')
    setTool('select')
    setSteps(startSteps([]))
    setMessage(`Added ${feature.name}`)
  }

  /** Drop the preview. The document was never touched. */
  const cancelPreview = () => {
    if (!previewFeature) return
    setPreviewFeature(null)
    setTool('select')
    setSteps(startSteps([]))
    setMessage('Extrusion cancelled')
  }

  const addSolid = (feature: CadFeature, nextTool: CadTool) => {
    commit(appendFeature(docRef.current, feature))
    draftRef.current = feature.id
    choose(feature.id)
    setTool(nextTool)
    setMessage(`Added ${feature.name}`)
    rememberFit()
  }

  const planeFromSelection = (): CadSketch['plane'] | null => {
    const plane = selected?.params.plane
    if (plane === 'XY' || plane === 'YZ' || plane === 'ZX') return plane
    return null
  }

  /** Start or reopen a sketch on a named datum plane. */
  const beginDatumSketch = (plane: SketchPlaneName) => {
    const opened = openFaceSketch(doc, { plane })
    if (opened.created) commit(opened.doc)
    choose(opened.feature.id)
    setActiveSketchId(opened.feature.id)
    setActivePlane(plane)
    setSteps(startSteps(stepsFor('sketch', sketchTool)))
    setSketchTool(sketchTool)
    setTool('sketch')
    setMessage(
      opened.created
        ? `Sketch ${opened.feature.name} on ${plane}`
        : `Editing ${opened.feature.name} on ${plane}`,
    )
  }

  const beginFaceSketch = (placement: FaceSketchPlacement) => {
    const opened = openFaceSketch(doc, placement)
    if (opened.created) commit(opened.doc)
    choose(opened.feature.id)
    setActiveSketchId(opened.feature.id)
    setActivePlane(opened.sketch.plane)
    setTool('sketch')
    const where = placementWhere(placement)
    setMessage(
      opened.created
        ? `Sketch ${opened.feature.name} on ${where}`
        : `Editing ${opened.feature.name} on ${where}`,
    )
  }

  const sketchTarget = (): CadFeature | null => {
    if (selected?.kind === 'sketch') return selected
    for (let index = doc.features.length - 1; index >= 0; index -= 1) {
      const feature = doc.features[index]
      if (feature?.kind === 'sketch') return feature
    }
    return null
  }

  const shapeId = (): string | null => {
    if (selected && isSolidFeature(selected)) return selected.id
    const last = meshes[meshes.length - 1]
    return last?.id ?? null
  }

  const onCommand = (next: CadTool) => {
    clearDraftTimer()
    draftRef.current = null
    // Remember which slot ran, so a pulldown keeps showing that tool.
    const owner = pulldownFor(next)
    if (owner) setLastUsed((map) => (map[owner.id] === next ? map : { ...map, [owner.id]: next }))
    // Switching tools retires the box: its value belonged to the old tool.
    // Written out rather than calling `closeFlyout` so this stays safe even if it
    // runs before that binding is initialised.
    setFlyoutAnchor(null)
    setFlyoutValue(null)
    setFlyoutSeed('')
    // A new tool starts its pick sequence from the top.
    setSteps(startSteps(stepsFor(next, next === 'sketch' ? sketchTool : null)))
    if (next === 'box') {
      addSolid(makeBoxFeature(docRef.current), 'box')
      return
    }
    if (next === 'cylinder') {
      addSolid(makeCylinderFeature(docRef.current), 'cylinder')
      return
    }
    if (next === 'sphere') {
      addSolid(makeSphereFeature(docRef.current), 'sphere')
      return
    }
    if (next === 'sketch') {
      if (tool !== 'sketch' && selected?.kind === 'sketch') {
        const sketch = doc.sketches.find((item) => item.id === selected.id)
        setActiveSketchId(selected.id)
        setActivePlane(sketch?.plane ?? 'XY')
        setTool('sketch')
        setMessage(`Editing ${selected.name}`)
        return
      }
      if (tool !== 'sketch' && pick?.kind === 'face') {
        const placement = placementFromHit(pick, meshes)
        if (placement) {
          beginFaceSketch(placement)
          return
        }
      }
      if (tool !== 'sketch' && meshes.length === 0) {
        beginDatumSketch(planeFromSelection() ?? optionsRef.current.sketchPlane)
        return
      }
      setActiveSketchId(null)
      setTool('sketch')
      setMessage('Pick a face to sketch on')
      return
    }
    if (next === 'extrude' || next === 'revolve') {
      const sketch = sketchTarget()
      setTool(next)
      if (!sketch) {
        setMessage(next === 'extrude' ? 'Select a sketch first' : toolStatusHint(next))
        return
      }
      const made =
        next === 'extrude'
          ? makeExtrudeFeature(docRef.current, sketch.id)
          : makeRevolveFeature(docRef.current, sketch.id)
      const patch = next === 'extrude' ? draftParamPatch('extrude', optionsRef.current) : null
      // Show it before committing it. Enter confirms, Escape throws it away.
      setPreviewFeature(patch ? { ...made, params: { ...made.params, ...patch } } : made)
      setMessage(
        next === 'extrude'
          ? 'Previewing the extrusion. Set the distance, then Enter to keep it or Esc to cancel.'
          : 'Previewing the revolve. Enter to keep it or Esc to cancel.',
      )
      return
    }
    if (next === 'fillet' || next === 'chamfer') {
      setTool(next)
      setMessage('Select edges, then press Enter or Apply')
      return
    }
    if (next === 'hole') {
      setTool('hole')
      if (pick?.point) {
        placeHole(pick)
        return
      }
      setMessage(toolStatusHint('hole'))
      return
    }
    if (next === 'union' || next === 'cut' || next === 'intersect') {
      const toolFeature = selected
      const target = docRef.current.features.find((feature) => feature.id === previousId) ?? null
      setTool(next)
      if (
        !toolFeature ||
        !target ||
        !isSolidFeature(toolFeature) ||
        !isSolidFeature(target) ||
        toolFeature.id === target.id
      ) {
        setMessage(
          'Select two solids. The previous selection is the target and the current one is the tool.',
        )
        return
      }
      addSolid(makeBooleanFeature(docRef.current, next, target.id, toolFeature.id), next)
      return
    }
    if (next === 'measure') {
      setTool('measure')
      void measure()
      return
    }
    if (next === 'import') {
      setTool(next)
      fileRef.current?.click()
      return
    }
    if (next === 'export') {
      setTool('export')
      setMessage(toolStatusHint('export'))
      return
    }
    setTool(next)
    setMessage(toolStatusHint(next))
  }

  const measure = async () => {
    const id = shapeId()
    if (!id) {
      setMessage(toolStatusHint('measure'))
      return
    }
    try {
      const result = await getClient().measure(id)
      const min = result.bbox.min.map((value) => trim(value)).join(', ')
      const max = result.bbox.max.map((value) => trim(value)).join(', ')
      const name = docRef.current.features.find((feature) => feature.id === id)?.name ?? 'Solid'
      // Kept in a list rather than a single slot so several features can be read at once.
      setAnnotations((list) =>
        addAnnotation(list, {
          id: `measure-${id}`,
          featureId: id,
          title: name,
          lines: [
            `Volume ${trim(result.volume)}`,
            `Area ${trim(result.area)}`,
            `BBox ${min} → ${max}`,
          ],
        }),
      )
      setMessage(`Measured ${name}`)
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Measure failed')
    }
  }

  const exportJson = () => {
    download('part.cad.json', JSON.stringify(doc, null, 2), 'application/json')
    setMessage('Exported part.cad.json')
  }

  const exportStep = async () => {
    const id = shapeId()
    if (!id) {
      setMessage('Select a solid to export')
      return
    }
    try {
      const bytes = await getClient().exportStep(id)
      download('part.step', copyBytes(bytes), 'application/step')
      setMessage('Exported part.step')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'STEP export failed')
    }
  }

  const exportStl = async () => {
    const id = shapeId()
    if (!id) {
      setMessage('Select a solid to export')
      return
    }
    try {
      const bytes = await getClient().exportStl(id)
      download('part.stl', copyBytes(bytes), 'model/stl')
      setMessage('Exported part.stl')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'STL export failed')
    }
  }

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const lower = file.name.toLowerCase()
    try {
      if (lower.endsWith('.step') || lower.endsWith('.stp')) {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const feature = makeImportFeature(doc, file.name)
        setStepFiles((current) => ({ ...current, [feature.id]: bytes }))
        commit(appendFeature(doc, feature))
        choose(feature.id)
        setMessage(`Imported ${file.name}`)
        rememberFit()
        return
      }
      const parsed: unknown = JSON.parse(await file.text())
      if (!isCadDocument(parsed)) {
        setMessage('That file is not a CAD document')
        return
      }
      commit(parsed)
      choose(null)
      setMessage(`Imported ${file.name}`)
      rememberFit()
    } catch {
      setMessage('Could not read that file')
    }
  }

  const placeHole = (hit: PickHit) => {
    const point = hit.point
    const owner = doc.features.find((feature) => feature.id === hit.featureId)
    if (hit.kind !== 'face' || !point || !owner) {
      setMessage(HOLE_STATUS)
      return
    }
    const mesh = meshes.find((item) => item.id === hit.featureId)
    const frame = mesh ? faceFrameFromMesh(mesh, hit.index, hit.faceId) : null
    if (!frame) {
      setMessage(HOLE_STATUS)
      return
    }
    const { holeThroughAll: throughAll, holeDiameter: diameter } = optionsRef.current
    const depth = holeDepth
    const placed = addHoleFromFace(doc, {
      targetId: owner.id,
      diameter,
      throughAll,
      ...(throughAll ? {} : { depth }),
      point,
      normal: frame.normal,
      planeOrigin: frame.origin,
    })
    commit(placed.doc)
    draftRef.current = placed.feature.id
    choose(placed.feature.id)
    setTool('hole')
    setMessage(`Hole ⌀${trim(diameter)} · ${placed.feature.name}`)
    rememberFit()
  }

  const applyEdges = () => {
    if (tool !== 'fillet' && tool !== 'chamfer') return
    const edges = pickedEdges.filter((hit) => hit.kind === 'edge')
    const target = edges[0]?.featureId
    if (!target) {
      setMessage('Select at least one edge')
      return
    }
    if (edges.some((hit) => hit.featureId !== target)) {
      setMessage('Select edges on the same body')
      return
    }
    const mesh = meshes.find((item) => item.id === target)
    if (!mesh) {
      setMessage('Selected body is no longer available')
      return
    }
    let merged: { edgeIds: string; edgeRefs?: string } = { edgeIds: '' }
    for (const hit of edges) {
      const found = signatureForEdge(mesh, hit.edgeId, hit.index)
      if (!found) {
        setMessage('Could not identify a selected edge')
        return
      }
      merged = mergeEdgeParams(merged.edgeIds, merged.edgeRefs, found)
    }
    const currentDoc = docRef.current
    const made =
      tool === 'fillet'
        ? makeFilletFeature(currentDoc, target, merged.edgeIds, undefined, merged.edgeRefs)
        : makeChamferFeature(currentDoc, target, merged.edgeIds, undefined, merged.edgeRefs)
    const patch = draftParamPatch(tool, optionsRef.current)
    const feature = patch ? { ...made, params: { ...made.params, ...patch } } : made
    addSolid(feature, 'select')
    viewport.current?.clearSelection()
    setMessage(
      `${feature.name} applied to ${edges.length} ${edges.length === 1 ? 'edge' : 'edges'}`,
    )
  }

  const onPick = (hit: PickHit | null) => {
    setPick(hit)
    if (hit) {
      const kind: StepInput =
        hit.kind === 'edge' ? 'edge' : hit.kind === 'vertex' ? 'point' : 'face'
      setSteps((state) => {
        const result = acceptInput(state, kind)
        if (result.state === state) return state
        // Only speak up when the step advanced. Tools that set their own message
        // for a pick keep it, so the wording stays specific.
        if (result.filled && state.index + 1 < state.steps.length) {
          setMessage(result.filled.prompt)
        }
        return result.state
      })
    }
    if (tool === 'sketch') {
      if (hit?.kind === 'face') {
        const placement = placementFromHit(hit, meshes)
        if (!placement) {
          setMessage('Could not read that face')
          return
        }
        beginFaceSketch(placement)
        return
      }
      setMessage('Pick a face to sketch on')
      return
    }
    if (!hit) {
      if (tool === 'hole') setMessage(HOLE_STATUS)
      else if (tool === 'fillet' || tool === 'chamfer') setMessage(EDGE_STATUS)
      else setMessage('Nothing picked')
      return
    }
    if (tool === 'hole') {
      placeHole(hit)
      return
    }
    if ((tool === 'fillet' || tool === 'chamfer') && hit.kind === 'edge') {
      setMessage('Select edges, then press Enter or Apply')
      return
    }
    if (tool === 'fillet' || tool === 'chamfer') {
      setMessage(EDGE_STATUS)
      return
    }
    choose(hit.featureId)
    const name = doc.features.find((feature) => feature.id === hit.featureId)?.name ?? 'feature'
    setMessage(`${hit.kind} ${edgeToken(hit) ?? hit.index} · ${name}`)
  }

  /**
   * Open the numeric box for the active tool.
   * `seed` keeps the digit that opened it so the first keystroke is not lost.
   */
  const openFlyout = (seed?: string) => {
    const field = quickFieldFor(tool, optionsRef.current)
    if (!field) return
    setFlyoutValue(null)
    // Sit over the viewport, not the feature tree, which occupies the left edge.
    setFlyoutAnchor({ x: viewportInset(paneRef.current), y: 18 })
    setFlyoutSeed(seed ?? '')
  }

  const closeFlyout = () => {
    setFlyoutAnchor(null)
    setFlyoutValue(null)
    setFlyoutSeed('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    const mod = event.metaKey || event.ctrlKey
    // A pending preview owns Enter and Escape.
    if (previewFeature) {
      if (event.key === 'Enter') {
        event.preventDefault()
        confirmPreview()
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelPreview()
        return
      }
    }
    // A bare digit opens the numeric box over the viewport, the way Chili3D does.
    // Fillet and chamfer included: their radius is the number most worth typing.
    if (!mod && !event.altKey && /^[0-9]$/.test(event.key)) {
      if (quickFieldFor(tool, optionsRef.current)) {
        event.preventDefault()
        openFlyout(event.key)
        return
      }
    }
    if (!mod && forcedEdge && (event.key === 'f' || event.key === 'F')) {
      if (quickFieldFor(tool, optionsRef.current)) {
        event.preventDefault()
        openFlyout()
        return
      }
    }
    if (!mod && forcedEdge && event.key === 'Enter') {
      event.preventDefault()
      applyEdges()
      return
    }
    if (!mod && forcedEdge && event.key === 'Escape') {
      event.preventDefault()
      viewport.current?.clearSelection()
      setTool('select')
      setSteps(startSteps([]))
      setMessage('Edge operation cancelled')
      return
    }
    // Backspace steps back one pick without restarting the tool.
    if (!mod && event.key === 'Backspace' && steps.index > 0) {
      event.preventDefault()
      setSteps((state) => ({ ...state, index: state.index - 1, rejection: null }))
      return
    }
    if (!mod) return
    const key = event.key.toLowerCase()
    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      undo()
    } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
      event.preventDefault()
      redo()
    }
  }

  const focusPane = (event: PointerEvent<HTMLDivElement>) => {
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    event.currentTarget.focus()
  }

  const placementFields = holePlacement(
    tool,
    selected,
    options.holeDiameter,
    options.holeThroughAll,
    holeDepth,
    tool === 'chamfer' ? options.chamferDistance : options.filletRadius,
  )

  const hint = previewFeature
    ? 'Set the distance, then Enter to keep it or Esc to cancel'
    : toolStatusHint(tool, tool === 'sketch' ? sketchTool : null)
  const sketching = tool === 'sketch' && activeSketchId !== null
  const progress = stepProgress(steps)
  const stepLine = progress.counter
    ? `${progress.prompt} (${progress.counter})`
    : progress.prompt
  const detail = loading ? 'Loading geometry…' : (failure ?? message)
  const showDetail = detail.length > 0 && detail !== hint && detail !== stepLine
  const quickFlyout = flyoutAnchor ? quickFieldFor(tool, options) : null

  return (
    <div
      className="cad-pane"
      ref={paneRef}
      tabIndex={0}
      data-active-sketch={activeSketchId ?? undefined}
      data-sketch-plane={activePlane}
      onKeyDown={onKeyDown}
      onPointerDown={focusPane}
    >
      <Toolbar
        active={tool}
        onCommand={onCommand}
        sketchTool={tool === 'sketch' ? sketchTool : null}
        onSketchTool={(next) => {
          if (tool !== 'sketch') {
            clearDraftTimer()
            draftRef.current = null
          }
          setSketchTool(next)
          setSteps(startSteps(stepsFor('sketch', next)))
          setTool('sketch')
          setMessage(activeSketchId ? `Sketch ${next}` : 'Pick a face to sketch on')
        }}
        options={options}
        lastUsed={lastUsed}
        onOptionsChange={onOptionsChange}
        onExport={(format) => {
          if (format === 'json') exportJson()
          else if (format === 'step') void exportStep()
          else void exportStl()
        }}
      />
      <div className="cad-body">
        <FeatureTree
          features={doc.features}
          historyIndex={doc.historyIndex}
          selectedId={selectedId}
          errors={errors}
          onSelect={choose}
          onSuppress={(id) => {
            const feature = doc.features.find((item) => item.id === id)
            if (!feature) return
            commit(updateFeature(doc, id, { suppressed: !feature.suppressed }))
          }}
          onDelete={(id) => {
            commit(removeFeature(doc, id))
            if (selectedId === id) choose(null)
          }}
          onReorder={(id, direction) => commit(moveFeature(doc, id, direction))}
        />
        <Viewport
          ref={viewport}
          meshes={meshes}
          selectedId={selectedId}
          fitRequest={fitRequest}
          onPick={onPick}
          loading={loading}
          sketchMode={tool === 'sketch' && activeSketchId !== null}
          sketchTool={sketchTool}
          plane={drawingPlane}
          sketchSnap={options.sketchSnap}
          polygonSides={options.polygonSides}
          snapEnabled={snapConfig.enabled}
          snapSettings={snapConfig.settings}
          entities={activeSketchEntities}
          onSketchChange={(entities) => {
            const id = activeSketchId ?? activeSketch?.id
            if (!id) return
            commit(setSketchEntities(doc, id, entities))
          }}
          onPlanePick={(plane) => {
            // A clicked datum plane goes straight into a sketch on that plane.
            beginDatumSketch(plane)
          }}
          onSketchPlaced={(count) => {
            // Sketch picks never reach `onPick`, so the step counter follows the
            // sketch draft directly.
            setSteps((state) => stepForPlaced(state, count))
          }}
          onSketchFinish={(entities) => {
            const id = activeSketchId ?? activeSketch?.id
            if (!id) return
            commit(setSketchEntities(doc, id, entities))
            // Finishing leaves the sketch: the camera goes back to 3D and the
            // next sensible step is extruding what was just drawn.
            setActiveSketchId(null)
            setTool('select')
            setSteps(startSteps([]))
            setMessage(
              `Sketch finished with ${entities.length} ${
                entities.length === 1 ? 'entity' : 'entities'
              }. Pick it and extrude.`,
            )
          }}
          measure={null}
          pickMode={activeFilter}
          onSelectionChange={(hits) => {
            setPickedEdges(hits.filter((hit) => hit.kind === 'edge'))
            if (hits.length > 1) setMessage(`${hits.length} ${activeFilter}s selected`)
          }}
        />
        <AnnotationCards
          items={annotations}
          onDismiss={(id) => setAnnotations((list) => removeAnnotation(list, id))}
        />
        {quickFlyout
          ? (() => {
              return (
                <NumericFlyout
                  key={`${quickFlyout.key}-${flyoutSeed}`}
                  anchor={flyoutAnchor}
                  seed={flyoutSeed || undefined}
                  value={flyoutValue}
                  unitLabel="mm"
                  field={quickFieldAsInput(quickFlyout, onOptionsChange, closeFlyout)}
                />
              )
            })()
          : null}
        <PropertiesPanel
          feature={selected}
          error={selected ? errors[selected.id] : undefined}
          placement={placementFields}
          onPlacement={(key, value) => {
            if (key === 'diameter' && typeof value === 'number' && value > 0)
              onOptionsChange({ holeDiameter: value })
            if (key === 'throughAll' && typeof value === 'boolean')
              onOptionsChange({ holeThroughAll: value })
            if (key === 'depth' && typeof value === 'number' && value > 0) setHoleDepth(value)
            if (key === 'radius' && typeof value === 'number' && value > 0)
              onOptionsChange(
                tool === 'chamfer' ? { chamferDistance: value } : { filletRadius: value },
              )
          }}
          onName={(name) => {
            if (!selected) return
            if (selected.id === draftRef.current) clearDraftTimer()
            commit(updateFeature(docRef.current, selected.id, { name }))
          }}
          onParam={(key, value) => {
            if (!selected) return
            if (selected.id === draftRef.current) {
              clearDraftTimer()
              draftRef.current = null
            }
            if (selected.kind === 'hole' && key === 'diameter' && typeof value === 'number') {
              onOptionsChange({ holeDiameter: value })
            }
            if (selected.kind === 'hole' && key === 'throughAll' && typeof value === 'boolean') {
              onOptionsChange({ holeThroughAll: value })
            }
            if (selected.kind === 'hole' && key === 'depth' && typeof value === 'number') {
              setHoleDepth(value)
            }
            if (
              (selected.kind === 'fillet' || selected.kind === 'chamfer') &&
              key === 'radius' &&
              typeof value === 'number'
            ) {
              onOptionsChange(
                selected.kind === 'chamfer' ? { chamferDistance: value } : { filletRadius: value },
              )
            }
            commit(updateFeature(docRef.current, selected.id, { params: { [key]: value } }))
          }}
        />
      </div>
      <footer className="cad-status">
        <button
          type="button"
          className="cad-icon"
          aria-label="Undo"
          title="Undo"
          disabled={!stack.current.canUndo()}
          onClick={undo}
        >
          <Undo2 size={13} />
        </button>
        <button
          type="button"
          className="cad-icon"
          aria-label="Redo"
          title="Redo"
          disabled={!stack.current.canRedo()}
          onClick={redo}
        >
          <Redo2 size={13} />
        </button>
        <span className="cad-filter" role="group" aria-label="Selection filter">
          {PICK_KINDS.map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={activeFilter === kind}
              disabled={forcedEdge && kind !== 'edge'}
              title={`Select ${kind}s. Shift adds, Ctrl-drag box selects.`}
              onClick={() => setPickFilter(kind)}
            >
              {kind === 'face' ? 'Face' : kind === 'edge' ? 'Edge' : 'Vertex'}
            </button>
          ))}
        </span>
        {forcedEdge ? (
          <button type="button" onClick={applyEdges} disabled={pickedEdges.length === 0}>
            Apply {tool} ({pickedEdges.length})
          </button>
        ) : null}
        {previewFeature ? (
          <span className="cad-preview-actions" role="group" aria-label="Preview">
            <button type="button" className="cad-preview-confirm" onClick={confirmPreview}>
              Keep
            </button>
            <button type="button" onClick={cancelPreview}>
              Cancel
            </button>
          </span>
        ) : null}
        {sketching ? (
          <span className="cad-preview-actions" role="group" aria-label="Sketch">
            <button
              type="button"
              className="cad-preview-confirm"
              title="Finish the sketch (Enter)"
              onClick={() => viewport.current?.finishSketch()}
            >
              Finish sketch
            </button>
            <button
              type="button"
              title="Leave the sketch"
              onClick={() => {
                setActiveSketchId(null)
                setTool('select')
                setSteps(startSteps([]))
                setMessage('Sketch closed')
              }}
            >
              Close
            </button>
          </span>
        ) : null}
        <span className="cad-status-hint" title={progress.tip ?? hint}>
          {steps.steps.length > 0 ? stepLine : hint}
        </span>
        <SnapMenu config={snapConfig} onChange={setSnapConfig} />
        <span>{doc.units}</span>
        <span>
          {doc.features.length} {doc.features.length === 1 ? 'feature' : 'features'}
        </span>
        <span>rev {doc.rev}</span>
        {showDetail ? <span className="cad-status-message">{detail}</span> : null}
      </footer>
      <input
        ref={fileRef}
        className="cad-file"
        type="file"
        accept=".cad.json,.json,.step,.stp,application/json"
        aria-label="Import CAD document or STEP"
        onChange={(event) => void onFile(event)}
      />
    </div>
  )
}

const HOLE_STATUS = 'Click a face to place hole'

/** Left edge of the viewport inside `.cad-body`, clear of the feature tree. */
const VIEWPORT_LEFT_INSET = 208

/**
 * Place the box over the viewport rather than the feature tree.
 * Measured from the live element so a resized pane still lines up.
 */
function viewportInset(pane: HTMLElement | null): number {
  const viewport = pane?.querySelector('.cad-viewport')
  const body = pane?.querySelector('.cad-body')
  if (!(viewport instanceof HTMLElement) || !(body instanceof HTMLElement)) {
    return VIEWPORT_LEFT_INSET
  }
  return Math.max(0, viewport.getBoundingClientRect().left - body.getBoundingClientRect().left) + 12
}
const EDGE_STATUS = 'Shift-click edges then set radius'

function holePlacement(
  tool: CadTool,
  selected: CadFeature | null,
  diameter: number,
  throughAll: boolean,
  depth: number,
  radius: number,
): { title: string; fields: PlacementField[] } | null {
  if (tool === 'hole' && selected?.kind !== 'hole') {
    const fields: PlacementField[] = [
      { key: 'diameter', label: 'Diameter', value: diameter },
      { key: 'throughAll', label: 'Through all', value: throughAll },
    ]
    if (!throughAll) fields.push({ key: 'depth', label: 'Depth', value: depth })
    return { title: 'Hole', fields }
  }
  if ((tool === 'fillet' || tool === 'chamfer') && selected?.kind !== tool) {
    return {
      title: tool === 'fillet' ? 'Fillet' : 'Chamfer',
      fields: [{ key: 'radius', label: 'Radius', value: radius }],
    }
  }
  return null
}

function withSketchPlane(doc: CadDocument, id: string, plane: CadSketch['plane']): CadDocument {
  const feature = doc.features.find((item) => item.id === id)
  const sketch = doc.sketches.find((item) => item.id === id)
  if (!feature && !sketch) return doc
  if (feature?.params.plane === plane && (!sketch || sketch.plane === plane)) return doc
  let next = doc
  if (feature && feature.params.plane !== plane) {
    next = updateFeature(next, id, { params: { plane } })
  }
  if (sketch && sketch.plane !== plane) {
    const sketches = next.sketches.map((item) => (item.id === id ? { ...item, plane } : item))
    if (next === doc) return { ...doc, sketches, rev: doc.rev + 1, updatedAt: Date.now() }
    return { ...next, sketches }
  }
  return next
}

function edgeToken(hit: PickHit | null): string | undefined {
  if (!hit || hit.kind !== 'edge') return undefined
  const withId = hit as PickHit & { edgeId?: number }
  return String(withId.edgeId ?? hit.index)
}

function trim(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 1000) / 1000
  return String(rounded)
}

function copyBytes(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function download(filename: string, data: BlobPart, mime: string) {
  const blob = new Blob([data], { type: mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}
