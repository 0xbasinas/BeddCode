import { Redo2, Undo2 } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { FeatureTree } from './FeatureTree.tsx'
import { PropertiesPanel } from './PropertiesPanel.tsx'
import { CAD_TOOLS, Toolbar, type CadTool, type SketchTool } from './Toolbar.tsx'
import { Viewport, type PickHit, type ViewportHandle } from './Viewport.tsx'
import {
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
 */
export function CadPane() {
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
  const [activeSketchId, setActiveSketchId] = useState<string | null>(null)
  const [activePlane, setActivePlane] = useState<CadSketch['plane']>('XY')
  const [sketchTool, setSketchTool] = useState<SketchTool>('rectangle')
  const [measureLabel, setMeasureLabel] = useState<string | null>(null)

  const { meshes, errors, loading, failure, getClient } = useCadRebuild(doc, stepFiles)
  const meshKey = meshes.map((mesh) => mesh.id).join('|')

  useEffect(() => {
    if (!fitArmed.current || loading) return
    fitArmed.current = false
    setFitRequest((value) => value + 1)
  }, [meshKey, loading])

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
      const selectedSolid = selected && isSolidFeature(selected) ? selected : null
      const edge =
        pick?.kind === 'edge' && (!selectedSolid || pick.featureId === selectedSolid.id)
          ? edgeToken(pick)
          : undefined
      const targetId = edge ? pick?.featureId : selectedSolid?.id
      setTool(next)
      if (!targetId) {
        setMessage('Select an edge or a solid')
        return
      }
      const feature =
        next === 'fillet'
          ? makeFilletFeature(doc, targetId, edge)
          : makeChamferFeature(doc, targetId, edge)
      addSolid(feature, next)
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

  const onPick = (hit: PickHit | null) => {
    setPick(hit)
    if (!hit) {
      setMessage('Nothing picked')
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
      className="cad-pane"
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
          pickMode={tool === 'fillet' || tool === 'chamfer' ? 'edge' : 'face'}
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
