import { Redo2, Undo2 } from 'lucide-react'
import {
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { FeatureTree } from './FeatureTree.tsx'
import { PropertiesPanel } from './PropertiesPanel.tsx'
import { CAD_TOOLS, Toolbar, type CadTool } from './Toolbar.tsx'
import { Viewport, type PickHit, type ViewportHandle } from './Viewport.tsx'
import {
  appendFeature,
  emptyDocument,
  isCadDocument,
  makeBoxFeature,
  moveFeature,
  removeFeature,
  updateFeature,
  type CadDocument,
} from './model/CadDocument.ts'
import { UndoStack } from './model/undo.ts'
import { meshForFeature } from './solids.ts'
import './cad.css'

/**
 * CAD pane: toolbar, feature tree, viewport, properties, and a status bar.
 * The arrangement follows a common solid modeler. It does not share code with Chili3D.
 * Solids other than a local box wait for the geometry kernel.
 */
export function CadPane() {
  const stack = useRef(new UndoStack(emptyDocument()))
  const viewport = useRef<ViewportHandle>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const [doc, setDoc] = useState<CadDocument>(() => stack.current.current())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tool, setTool] = useState<CadTool>('select')
  const [message, setMessage] = useState('Empty scene. New box adds a local solid.')
  const [fitRequest, setFitRequest] = useState(0)

  const commit = (next: CadDocument) => {
    if (next === doc) return
    stack.current.push(next)
    setDoc(stack.current.current())
  }

  const undo = () => setDoc(stack.current.undo())
  const redo = () => setDoc(stack.current.redo())

  const meshes = useMemo(() => {
    const built = []
    for (let index = 0; index < doc.features.length; index++) {
      const feature = doc.features[index]
      if (!feature || index > doc.historyIndex) continue
      const mesh = meshForFeature(feature)
      if (mesh) built.push(mesh)
    }
    return built
  }, [doc])

  const selected = doc.features.find((feature) => feature.id === selectedId) ?? null

  const addBox = () => {
    const feature = makeBoxFeature(doc)
    commit(appendFeature(doc, feature))
    setSelectedId(feature.id)
    setTool('box')
    setMessage(`Added ${feature.name}`)
    setFitRequest((value) => value + 1)
  }

  const exportDoc = () => {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'part.cad.json'
    link.click()
    URL.revokeObjectURL(url)
    setTool('export')
    setMessage('Exported part.cad.json')
  }

  const onCommand = (next: CadTool) => {
    if (next === 'box') {
      addBox()
      return
    }
    if (next === 'import') {
      setTool(next)
      fileRef.current?.click()
      return
    }
    if (next === 'export') {
      exportDoc()
      return
    }
    setTool(next)
    if (next === 'select') {
      setMessage('Select a face. Shift-click an edge.')
      return
    }
    const label = CAD_TOOLS.find((item) => item.id === next)?.label ?? next
    setMessage(`${label} needs the geometry kernel.`)
  }

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const parsed: unknown = JSON.parse(await file.text())
      if (!isCadDocument(parsed)) {
        setMessage('That file is not a CAD document')
        return
      }
      commit(parsed)
      setSelectedId(null)
      setMessage(`Imported ${file.name}`)
      setFitRequest((value) => value + 1)
    } catch {
      setMessage('Could not read that file')
    }
  }

  const onPick = (hit: PickHit | null) => {
    if (!hit) {
      setMessage('Nothing picked')
      return
    }
    setSelectedId(hit.featureId)
    const name = doc.features.find((feature) => feature.id === hit.featureId)?.name ?? 'feature'
    setMessage(`${hit.kind} ${hit.index} · ${name}`)
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

  return (
    <div className="cad-pane" tabIndex={0} onKeyDown={onKeyDown} onPointerDown={focusPane}>
      <Toolbar active={tool} onCommand={onCommand} />
      <div className="cad-body">
        <FeatureTree
          features={doc.features}
          historyIndex={doc.historyIndex}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onSuppress={(id) => {
            const feature = doc.features.find((item) => item.id === id)
            if (!feature) return
            commit(updateFeature(doc, id, { suppressed: !feature.suppressed }))
          }}
          onDelete={(id) => {
            commit(removeFeature(doc, id))
            if (selectedId === id) setSelectedId(null)
          }}
          onReorder={(id, direction) => commit(moveFeature(doc, id, direction))}
        />
        <Viewport
          ref={viewport}
          meshes={meshes}
          selectedId={selectedId}
          fitRequest={fitRequest}
          onPick={onPick}
        />
        <PropertiesPanel
          feature={selected}
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
        <span className="cad-status-message">{message}</span>
      </footer>
      <input
        ref={fileRef}
        className="cad-file"
        type="file"
        accept="application/json,.json"
        aria-label="Import CAD document"
        onChange={(event) => void onFile(event)}
      />
    </div>
  )
}
