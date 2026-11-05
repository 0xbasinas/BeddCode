import { Redo2, Undo2 } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useHostKey } from '../../stores/HostScope.tsx'
import { reportCadView } from '../../stores/host.ts'
import {
  emitCadMaximize,
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
import { PropertiesPanel } from './PropertiesPanel.tsx'
import { Toolbar, type CadTool, type SketchTool } from './Toolbar.tsx'
import { PICK_KINDS, type PickKind } from './selection.ts'
import { Viewport, type PickHit, type ViewportHandle } from './Viewport.tsx'
import { mergeEdgeParams, roundMm, signatureForEdge } from './edgeRefs.ts'
import {
  addHole,
  appendFeature,
  appendSketch,
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
  removeFeature,
  setSketchEntities,
  updateFeature,
  type CadDocument,
  type CadFeature,
  type CadSketch,
} from './model/CadDocument.ts'
import { UndoStack } from './model/undo.ts'
import type { SketchEntity as DrawnEntity } from './sketcher/types.ts'
import { useCadRebuild } from './useCadRebuild.ts'
import './cad.css'

/**
 * CAD pane: toolbar, feature tree, viewport, properties, and a status bar.
 * The arrangement follows a common solid modeler. It does not share code with Chili3D.
 * Solids are rebuilt through createCadClient() and OpenCascade.
 *
 * Maximize dispatches `beddcode:cad-maximize` with `{ maximized: boolean }` and sets
 * `.cad-pane--max`. The shell listens and toggles `.right.cad-open.cad-maximized`.
 */
export function CadPane() {
  const hostKey = useHostKey()
  const stack = useRef(new UndoStack(emptyDocument()))
  const viewport = useRef<ViewportHandle>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const fitArmed = useRef(false)
  const [doc, setDoc] = useState<CadDocument>(() => stack.current.current())
  const [stepFiles, setStepFiles] = useState<Record<string, Uint8Array>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [previousId, setPreviousId] = useState<string | null>(null)
  const [tool, setTool] = useState<CadTool>('select')
  const [message, setMessage] = useState('Ready')
  const [fitRequest, setFitRequest] = useState(0)
  const [pick, setPick] = useState<PickHit | null>(null)
  const [pickFilter, setPickFilter] = useState<PickKind>('face')
  const forcedEdge = tool === 'fillet' || tool === 'chamfer'
  const activeFilter: PickKind = forcedEdge ? 'edge' : pickFilter
  const [activeSketchId, setActiveSketchId] = useState<string | null>(null)
  const [activePlane, setActivePlane] = useState<CadSketch['plane']>('XY')
  const [sketchTool, setSketchTool] = useState<SketchTool>('rectangle')
  const [measureLabel, setMeasureLabel] = useState<string | null>(null)
  const [maximized, setMaximized] = useState(false)

  const { meshes, errors, loading, failure, getClient } = useCadRebuild(doc, stepFiles)
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
    const selection = selectedId ? [selectedId] : []
    setCadView({ canRender: true, documentId: doc.id, selection })
    reportCadView(hostKey, { documentId: doc.id, selection })
  }, [hostKey, doc.id, selectedId])

  useEffect(() => {
    return () => {
      setCadView({ canRender: false, selection: [] })
      reportCadView(hostKey, null)
      emitCadMaximize(false)
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
      setDoc(stack.current.current())
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
    if (next === doc) return
    stack.current.push(next)
    setDoc(stack.current.current())
  }

  const undo = () => setDoc(stack.current.undo())
  const redo = () => setDoc(stack.current.redo())

  const choose = (id: string | null) => {
    if (id && selectedId && id !== selectedId) setPreviousId(selectedId)
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

  const addSolid = (feature: CadFeature, nextTool: CadTool) => {
    commit(appendFeature(doc, feature))
    choose(feature.id)
    setTool(nextTool)
    setMessage(`Added ${feature.name}`)
    rememberFit()
  }

  const selectedPlane = (): CadSketch['plane'] => {
    const plane = selected?.params.plane
    if (plane === 'XY' || plane === 'YZ' || plane === 'ZX') return plane
    return 'XY'
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
    if (next === 'box') {
      addSolid(makeBoxFeature(doc), 'box')
      return
    }
    if (next === 'cylinder') {
      addSolid(makeCylinderFeature(doc), 'cylinder')
      return
    }
    if (next === 'sphere') {
      addSolid(makeSphereFeature(doc), 'sphere')
      return
    }
    if (next === 'sketch') {
      const plane = selectedPlane()
      const appended = appendSketch(doc, plane)
      commit(appended.doc)
      choose(appended.feature.id)
      setActiveSketchId(appended.feature.id)
      setActivePlane(plane)
      setTool('sketch')
      setMessage(`Sketch ${appended.feature.name} on ${plane}`)
      return
    }
    if (next === 'extrude' || next === 'revolve') {
      const sketch = sketchTarget()
      setTool(next)
      if (!sketch) {
        setMessage('Select a sketch first')
        return
      }
      const feature =
        next === 'extrude' ? makeExtrudeFeature(doc, sketch.id) : makeRevolveFeature(doc, sketch.id)
      addSolid(feature, next)
      return
    }
    if (next === 'fillet' || next === 'chamfer') {
      setTool(next)
      if (pick?.kind === 'edge') {
        placeEdge(pick, next)
        return
      }
      setMessage(next === 'fillet' ? 'Pick edges to fillet' : 'Pick edges to chamfer')
      return
    }
    if (next === 'hole') {
      setTool('hole')
      if (pick?.point) {
        placeHole(pick)
        return
      }
      setMessage('Pick a face to place the hole')
      return
    }
    if (next === 'union' || next === 'cut' || next === 'intersect') {
      const toolFeature = selected
      const target = doc.features.find((feature) => feature.id === previousId) ?? null
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
      addSolid(makeBooleanFeature(doc, next, target.id, toolFeature.id), next)
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
      setMessage('Choose JSON, STEP, or STL')
      return
    }
    setTool(next)
    if (next === 'select') setMessage('Select a face. Shift-click an edge.')
  }

  const measure = async () => {
    const id = shapeId()
    if (!id) {
      setMessage('Select a solid to measure')
      return
    }
    try {
      const result = await getClient().measure(id)
      const min = result.bbox.min.map((value) => trim(value)).join(', ')
      const max = result.bbox.max.map((value) => trim(value)).join(', ')
      const label = `Volume ${trim(result.volume)} · Area ${trim(result.area)} · BBox [${min}] – [${max}]`
      setMeasureLabel(label)
      setMessage(label)
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
    if (!hit.point) {
      setMessage('Pick a face to place the hole')
      return
    }
    const placed = addHole(doc, {
      target: hit.featureId,
      diameter: 8,
      depth: 10,
      throughAll: true,
      x: roundMm(hit.point[0]),
      y: roundMm(hit.point[1]),
      z: roundMm(hit.point[2]),
    })
    commit(placed.doc)
    choose(placed.feature.id)
    setTool('hole')
    setMessage(`Hole ⌀8 · ${placed.feature.name}`)
    rememberFit()
  }

  const placeEdge = (hit: PickHit, kind: 'fillet' | 'chamfer') => {
    const mesh = meshes.find((item) => item.id === hit.featureId)
    const found = mesh ? signatureForEdge(mesh, hit.edgeId, hit.index) : null
    const edgeId = found?.edgeId ?? hit.edgeId ?? hit.index
    const added = { edgeId, ref: found?.ref ?? null }
    const current = doc.features.find((feature) => feature.id === selectedId)
    const sameTarget =
      current?.kind === kind &&
      (current.params.targetId === hit.featureId || current.params.target === hit.featureId)
    const label = kind === 'fillet' ? 'Fillet' : 'Chamfer'
    if (sameTarget && current) {
      const merged = mergeEdgeParams(current.params.edgeIds, current.params.edgeRefs, added)
      commit(
        updateFeature(doc, current.id, {
          params: {
            edgeIds: merged.edgeIds,
            edgeRefs: merged.edgeRefs ?? '',
          },
        }),
      )
      setMessage(`${label} edges ${merged.edgeIds}`)
      return
    }
    const merged = mergeEdgeParams(undefined, undefined, added)
    const feature =
      kind === 'fillet'
        ? makeFilletFeature(doc, hit.featureId, merged.edgeIds, undefined, merged.edgeRefs)
        : makeChamferFeature(doc, hit.featureId, merged.edgeIds, undefined, merged.edgeRefs)
    addSolid(feature, kind)
    setMessage(`${label} edges ${merged.edgeIds}`)
  }

  const toggleMaximize = () => {
    setMaximized((value) => {
      const next = !value
      emitCadMaximize(next)
      return next
    })
  }

  const onPick = (hit: PickHit | null) => {
    setPick(hit)
    if (!hit) {
      setMessage(tool === 'hole' ? 'Pick a face to place the hole' : 'Nothing picked')
      return
    }
    if (tool === 'hole') {
      placeHole(hit)
      return
    }
    if ((tool === 'fillet' || tool === 'chamfer') && hit.kind === 'edge') {
      placeEdge(hit, tool)
      return
    }
    choose(hit.featureId)
    const name = doc.features.find((feature) => feature.id === hit.featureId)?.name ?? 'feature'
    setMessage(`${hit.kind} ${edgeToken(hit) ?? hit.index} · ${name}`)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return
    const mod = event.metaKey || event.ctrlKey
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

  const status = loading ? 'Loading geometry…' : (failure ?? message)

  return (
    <div
      className={`cad-pane${maximized ? ' cad-pane--max' : ''}`}
      tabIndex={0}
      data-active-sketch={activeSketchId ?? undefined}
      data-sketch-plane={activePlane}
      onKeyDown={onKeyDown}
      onPointerDown={focusPane}
    >
      <Toolbar
        active={tool}
        onCommand={onCommand}
        maximized={maximized}
        onMaximize={toggleMaximize}
        sketchTool={tool === 'sketch' ? sketchTool : null}
        onSketchTool={(next) => {
          setSketchTool(next)
          setTool('sketch')
          setMessage(`Sketch ${next}`)
        }}
      />
      {tool === 'export' ? (
        <div className="cad-toolbar" role="menu" aria-label="Export">
          <button type="button" className="cad-tool" onClick={exportJson}>
            JSON
          </button>
          <button type="button" className="cad-tool" onClick={() => void exportStep()}>
            STEP
          </button>
          <button type="button" className="cad-tool" onClick={() => void exportStl()}>
            STL
          </button>
        </div>
      ) : null}
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
          sketchMode={tool === 'sketch'}
          sketchTool={sketchTool}
          plane={activePlane}
          entities={activeSketchEntities}
          onSketchChange={(entities) => {
            const id = activeSketchId ?? activeSketch?.id
            if (!id) return
            commit(setSketchEntities(doc, id, entities))
          }}
          onSketchFinish={(entities) => {
            const id = activeSketchId ?? activeSketch?.id
            if (!id) return
            commit(setSketchEntities(doc, id, entities))
            setMessage(`Sketch finished · ${entities.length} entities`)
          }}
          measure={measureLabel ? { label: measureLabel } : null}
          pickMode={activeFilter}
          onSelectionChange={(hits) => {
            if (hits.length > 1) setMessage(`${hits.length} ${activeFilter}s selected`)
          }}
        />
        <PropertiesPanel
          feature={selected}
          error={selected ? errors[selected.id] : undefined}
          onName={(name) => {
            if (!selected) return
            commit(updateFeature(doc, selected.id, { name }))
          }}
          onParam={(key, value) => {
            if (!selected) return
            commit(updateFeature(doc, selected.id, { params: { [key]: value } }))
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
        <span>{doc.units}</span>
        <span>
          {doc.features.length} {doc.features.length === 1 ? 'feature' : 'features'}
        </span>
        <span>rev {doc.rev}</span>
        <span className="cad-status-message">{status}</span>
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
