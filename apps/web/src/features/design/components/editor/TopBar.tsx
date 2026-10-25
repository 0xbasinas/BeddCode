// @ts-nocheck
import React, { useState, useCallback, useEffect } from 'react'
import {
  ChevronDown,
  PanelLeft,
  Plus,
  Minus,
  Maximize2,
  Play,
  Share2,
  Undo2,
  Redo2,
  Download,
  FileText,
  FolderOpen,
  Save,
  CloudOff,
  Check,
  Group,
  Ungroup,
  ArrowUpToLine,
  ArrowDownToLine,
  BringToFront,
  SendToBack,
  FlipHorizontal2,
  FlipVertical2,
  AlignLeft,
  AlignCenterHorizontal,
  AlignRight,
  AlignStartVertical,
  AlignCenterVertical,
  AlignEndVertical,
  Space,
  MousePointer2,
  Frame,
  Square,
  Circle,
  Spline,
  MoveRight,
  Pen,
  Type,
  Hand,
  Pipette,
} from 'lucide-react'
import { useEditorStore } from '../../store/editor-store'
// PHASE 23 (F1–F4) — clipboard exports (source: 5018 design ctx menu)
import { copyAsPngToClipboard, copyAsSvgToClipboard, copyTextToClipboard, copyLayerNameToClipboard } from '../../lib/clipboard-io'
import type { DesignElement } from '../../store/editor-store'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '../ui/dropdown-menu'
import { exportDesign, type ExportFormat } from '../../lib/export'
import { importFiles, pickFiles } from '../../lib/import/handlers'
import { IMAGE_IMPORT_ACCEPT } from '../../lib/import/image-import'
import { saveProject, loadProject, listProjects } from '../../lib/storage'
import { pushProjectToServer } from '../../lib/server-project'
import { createVidVerseDesign } from '../../data/demo-design'
import { findElementInList } from '../../lib/element-utils'
import { isBooleanOperandType } from '../../lib/boolean-ops'
import { toast } from '../../hooks/use-toast'

export function TopBar() {
  const { zoom, setZoom, setPan, toggleLeftSidebar, toggleRightSidebar, fileName, setFileName, undo, redo, pushHistory, lastSavedAt, isSaving, isDirty, setLastSavedAt, setSaving, setDirty, elements, pages, guides, loadElements, loadServerProject } = useEditorStore()
  const currentProjectId = useEditorStore((s) => s.currentProjectId)
  const syncStatus = useEditorStore((s) => s.syncStatus)
  const lastRemoteOrigin = useEditorStore((s) => s.lastRemoteOrigin)
  const [isEditingName, setIsEditingName] = useState(false)
  const [showSaveIndicator, setShowSaveIndicator] = useState(false)
  const [serverProjects, setServerProjects] = useState<{ id: string; name: string }[]>([])
  const [loadingServer, setLoadingServer] = useState(false)

  // Auto-save (IndexedDB locally + server push when a server project is open)
  useEffect(() => {
    const interval = setInterval(async () => {
      const state = useEditorStore.getState()
      if (!state.isDirty) return
      
      state.setSaving(true)
      try {
        const savedAt = await saveProject({
          id: 'current',
          elements: state.elements,
          pages: state.pages,
          fileName: state.fileName,
          guides: state.guides,
        })
        // Live sync: push to the server so other tabs / MCP see our edits.
        const serverAt = await pushProjectToServer(state)
        state.setLastSavedAt(savedAt)
        state.setDirty(false)
        if (serverAt) {
          setShowSaveIndicator(true)
          setTimeout(() => setShowSaveIndicator(false), 2000)
        }
      } catch (e) {
        console.error('Auto-save failed:', e)
      } finally {
        state.setSaving(false)
      }
    }, 30000)
    return () => clearInterval(interval)
  }, [])

  const handleSave = useCallback(async () => {
    const state = useEditorStore.getState()
    state.setSaving(true)
    try {
      const savedAt = await saveProject({
        id: 'current',
        elements: state.elements,
        pages: state.pages,
        fileName: state.fileName,
        guides: state.guides,
      })
      // Live sync: push to the server so other tabs / MCP see our edits.
      await pushProjectToServer(state)
      state.setLastSavedAt(savedAt)
      state.setDirty(false)
      setShowSaveIndicator(true)
      setTimeout(() => setShowSaveIndicator(false), 2000)
    } catch (e) {
      console.error('Save failed:', e)
    } finally {
      state.setSaving(false)
    }
  }, [])

  const handleLoad = useCallback(async () => {
    try {
      const data = await loadProject('current')
      if (data && data.elements) {
        loadElements(data.elements)
        setFileName(data.fileName || 'Untitled')
        setShowSaveIndicator(true)
        setTimeout(() => setShowSaveIndicator(false), 2000)
      }
    } catch (e) {
      console.error('Load failed:', e)
    }
  }, [loadElements, setFileName])

  const handleLoadFromServer = useCallback(async (projectId: string) => {
    setLoadingServer(true)
    try {
      await loadServerProject(projectId)
      setShowSaveIndicator(true)
      setTimeout(() => setShowSaveIndicator(false), 2000)
    } catch (e) {
      console.error('Load from server failed:', e)
    } finally {
      setLoadingServer(false)
    }
  }, [loadServerProject])

  const fetchServerProjects = useCallback(async () => {
    try {
      const res = await fetch('/api/editor/projects')
      const data = await res.json()
      setServerProjects(data.projects || [])
    } catch (e) {
      console.error('Failed to fetch server projects:', e)
    }
  }, [])

  // PHASE 3: unified quick export (any of the 5 formats) at 2x default.
  const handleExportFormat = useCallback(async (format: ExportFormat) => {
    await exportDesign({ format, scale: 2, quality: 0.92, fileName })
  }, [fileName])

  const formatSaveTime = (timestamp: number | null) => {
    if (!timestamp) return 'Not saved'
    const diff = Date.now() - timestamp
    if (diff < 60000) return 'Saved just now'
    if (diff < 3600000) return `Saved ${Math.floor(diff / 60000)}m ago`
    return `Saved at ${new Date(timestamp).toLocaleTimeString()}`
  }

  return (
    <div className="h-10 bg-[color:var(--dc-raised)] flex items-center justify-between gap-2 px-1 overflow-x-auto overflow-y-hidden custom-scrollbar [&>*]:shrink-0 select-none border-b border-[color:var(--dc-app)] shrink-0">
      {/* Left section */}
      <div className="flex items-center gap-1">
        <button onClick={toggleLeftSidebar} className="flex items-center justify-center w-7 h-7 rounded hover:bg-[color:var(--dc-hover)] transition-colors duration-100" title="Toggle left panel">
          <PanelLeft className="w-4 h-4 text-[color:var(--dc-text2)]" />
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center h-6 px-2 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-text2)] text-[11px] transition-colors duration-100">File</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)] min-w-[200px]">
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.setSelectedElementIds([]); s.closeServerProject() }}>
              <FileText className="w-4 h-4 mr-2" />New Design<DropdownMenuShortcut>⌘N</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={handleLoad}>
              <FolderOpen className="w-4 h-4 mr-2" />Open...<DropdownMenuShortcut>⌘O</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={handleSave}>
              <Save className="w-4 h-4 mr-2" />Save<DropdownMenuShortcut>⌘S</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={fetchServerProjects}>
                <CloudOff className="w-4 h-4 mr-2" />Load from Server
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)]">
                {serverProjects.length === 0 ? (
                  <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[color:var(--dc-faint)]" disabled>
                    No projects found
                  </DropdownMenuItem>
                ) : (
                  serverProjects.map((p) => (
                    <DropdownMenuItem key={p.id} className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => handleLoadFromServer(p.id)}>
                      {loadingServer ? 'Loading...' : p.name}
                    </DropdownMenuItem>
                  ))
                )}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            {/* PHASE 4: real import menu — images / editable SVG / project JSON */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]">
                <FolderOpen className="w-4 h-4 mr-2" />Import
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)]">
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => pickFiles(IMAGE_IMPORT_ACCEPT, true, (files) => void importFiles(files))}>
                  Images… (PNG / JPG / WEBP / GIF)
                </DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => pickFiles('.svg,image/svg+xml', true, (files) => void importFiles(files))}>
                  SVG… (editable shapes)
                </DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => pickFiles('application/json,.json', false, (files) => void importFiles(files))}>
                  Project JSON… (replaces document)
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => {
              const state = useEditorStore.getState()
              state.pushHistory()
              state.loadElements(createVidVerseDesign())
              state.setFileName('VidVerse Mobile App')
            }}>
              <FileText className="w-4 h-4 mr-2" />Load Demo Design
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]">
                <Download className="w-4 h-4 mr-2" />Export
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)]">
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => handleExportFormat('PNG')}>Export as PNG</DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => handleExportFormat('JPG')}>Export as JPG</DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => handleExportFormat('SVG')}>Export as SVG</DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => handleExportFormat('PDF')}>Export as PDF</DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => handleExportFormat('WEBP')}>Export as WEBP</DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center h-6 px-2 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-text2)] text-[11px] transition-colors duration-100">Edit</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)] min-w-[200px]">
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => undo()}><Undo2 className="w-4 h-4 mr-2" />Undo<DropdownMenuShortcut>⌘Z</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => redo()}><Redo2 className="w-4 h-4 mr-2" />Redo<DropdownMenuShortcut>⌘⇧Z</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().copySelected()}>Copy<DropdownMenuShortcut>⌘C</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { pushHistory(); useEditorStore.getState().pasteClipboard() }}>Paste<DropdownMenuShortcut>⌘V</DropdownMenuShortcut></DropdownMenuItem>
            {/* PHASE 21 (E14) — paste over selection (source: PASTE_OVER_SELECTION=53,
                action "paste-over-selection", is_edit:!0). Shortcut: Figma-documented
                ⇧⌘V (not source-extracted — registry is minified). */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { pushHistory(); useEditorStore.getState().pasteOverSelection() }}>Paste Over Selection<DropdownMenuShortcut>⇧⌘V</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { pushHistory(); useEditorStore.getState().duplicateSelectedElements() }}>Duplicate<DropdownMenuShortcut>⌘D</DropdownMenuShortcut></DropdownMenuItem>
            {/* PHASE 23 (F1–F4) — copy-as menu (source: 5018 design/dev ctx:
                {action:"copy-as-png"} / copy-as-svg / copy-text / copy-layer-name,
                gated by isExportBlockedByApprovals). ⇧⌘C is the Figma-documented
                binding for Copy as PNG (registry minified in source). */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => {
              const s = useEditorStore.getState()
              const el = s.selectedElementIds.length ? findElementInList(s.elements, s.selectedElementIds[0]) : null
              if (el) copyAsPngToClipboard(el, 2)
            }}>Copy as PNG<DropdownMenuShortcut>⇧⌘C</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => {
              const s = useEditorStore.getState()
              const el = s.selectedElementIds.length ? findElementInList(s.elements, s.selectedElementIds[0]) : null
              if (el) copyAsSvgToClipboard(el)
            }}>Copy as SVG</DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => {
              const s = useEditorStore.getState()
              const el = s.selectedElementIds.length ? findElementInList(s.elements, s.selectedElementIds[0]) : null
              if (el) copyTextToClipboard(el)
            }}>Copy Text</DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => {
              const s = useEditorStore.getState()
              const el = s.selectedElementIds.length ? findElementInList(s.elements, s.selectedElementIds[0]) : null
              if (el) copyLayerNameToClipboard(el)
            }}>Copy Layer Name</DropdownMenuItem>
            {/* PHASE 23 (F5) — copy/paste properties (source: copy-properties
                view_restricted + paste-properties edit, 5018 ctx menu) */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().copyProperties()}>Copy Properties</DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { pushHistory(); useEditorStore.getState().pasteProperties() }}>Paste Properties</DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { pushHistory(); useEditorStore.getState().deleteSelectedElements() }}>Delete<DropdownMenuShortcut>⌫</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            {/* PHASE 21 (E16) — find & replace (source: FIND_AND_REPLACE=4;
                "load all pages before search"). No source-extractable shortcut. */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setFindReplaceOpen(true)}>Find and Replace…</DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            {/* PHASE 23 (F10) — frame selection (source: frame-selection /
                convert-selected-nodes-to-frame, figma_app). ⌥⌘G is the
                Figma-documented binding (registry minified in source). */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { pushHistory(); useEditorStore.getState().frameSelection() }}>Frame Selection<DropdownMenuShortcut>⌥⌘G</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().selectAll()}>Select All<DropdownMenuShortcut>⌘A</DropdownMenuShortcut></DropdownMenuItem>
            {/* PHASE 21 (E15) — select similar / inverse + select-all-with submenu
                (source children: select-same-{style,fill,stroke,effect,text,font,instance,variant}) */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().selectSimilar('similar')}>Select Similar</DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().selectInverse()}>Select Inverse</DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]">Select All With</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)] min-w-[190px]">
                {([
                  ['style', 'Same style'],
                  ['fill', 'Same fill'],
                  ['stroke', 'Same stroke'],
                  ['effect', 'Same effect'],
                  ['text', 'Same type'],
                  ['font', 'Same font'],
                  ['instance', 'Same instance'],
                  ['variant', 'Same variant'],
                ] as const).map(([key, label]) => (
                  <DropdownMenuItem key={key} className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().selectSimilar(key)}>
                    {label}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center h-6 px-2 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-text2)] text-[11px] transition-colors duration-100">View</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)] min-w-[200px]">
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => setZoom(zoom + 0.25)}>Zoom In<DropdownMenuShortcut>⌘+</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => setZoom(zoom - 0.25)}>Zoom Out<DropdownMenuShortcut>⌘-</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { setZoom(1); setPan(0, 0) }}>Zoom to 100%<DropdownMenuShortcut>⌘1</DropdownMenuShortcut></DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setShowGrid(!useEditorStore.getState().showGrid)}>Toggle Grid</DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setShowRulers(!useEditorStore.getState().showRulers)}>Toggle Rulers</DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setSnapToGrid(!useEditorStore.getState().snapToGrid)}>Toggle Snap to Grid</DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setSnapToElements(!useEditorStore.getState().snapToElements)}>Toggle Snap to Elements</DropdownMenuItem>
            {/* PHASE 23 (F14) — comment visibility (source: toggle-show-comments,
                figma_app ×2, comments sidebar setting) */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setShowComments(!useEditorStore.getState().showComments)}>
              Show Comments
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            {/* PHASE 21 (VW17) — outline mode + variants (source: toggle-outlines,
                toggle-outline-mode-hidden-layers, toggle-outline-mode-object-bounds).
                Shortcut ⌘⇧O is Figma-documented (registry minified in source). */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.setOutlinesMode(!s.outlinesMode) }}>
              Outlines<DropdownMenuShortcut>⌘⇧O</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" disabled={!useEditorStore.getState().outlinesMode} onClick={() => { const s = useEditorStore.getState(); s.setOutlineHiddenLayers(!s.outlineHiddenLayers) }}>
              Outlines: Hidden Layers
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" disabled={!useEditorStore.getState().outlinesMode} onClick={() => { const s = useEditorStore.getState(); s.setOutlineObjectBounds(!s.outlineObjectBounds) }}>
              Outlines: Object Bounds
            </DropdownMenuItem>
            {/* PHASE 21 (VW18) — pixel preview + retina (source: toggle-pixel-preview /
                activeCanvasPixelPreview, activeCanvasRetinaMode). ⌘⇧P Figma-documented. */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.setPixelPreview(!s.pixelPreview) }}>
              Pixel Preview<DropdownMenuShortcut>⌘⇧P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" disabled={!useEditorStore.getState().pixelPreview} onClick={() => { const s = useEditorStore.getState(); s.setPixelPreviewRetina(!s.pixelPreviewRetina) }}>
              Pixel Preview: Retina
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            {/* PHASE 22 (C19) — multiplayer presence (source: multiplayer_cursors
                visual_bell + toggle-viewport-overlay-hiding / temporarilyHideViewportOverlay) */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.setShowMultiplayerCursors(!s.showMultiplayerCursors) }}>
              Multiplayer Cursors
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.setHideViewportOverlay(!s.hideViewportOverlay) }}>
              Hide Viewport Overlay
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={toggleLeftSidebar}>Toggle Left Panel</DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={toggleRightSidebar}>Toggle Right Panel</DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            {/* PHASE 23 (F13) — keyboard shortcuts modal (source:
                keyboard_settings.keyboard_shortcuts_modal, figma_app). ⌘/ bound
                by us (registry minified in source). */}
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setShortcutsOpen(true)}>
              Keyboard Shortcuts<DropdownMenuShortcut>⌘/</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center h-6 px-2 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-text2)] text-[11px] transition-colors duration-100">Object</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)] min-w-[220px]">
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); if (s.selectedElementIds.length >= 2) { s.pushHistory(); s.groupElements(s.selectedElementIds) } }}>
              <Group className="w-4 h-4 mr-2" />Group<DropdownMenuShortcut>⌘G</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); if (s.selectedElementIds.length === 1) { s.pushHistory(); s.ungroupElements(s.selectedElementIds[0]) } }}>
              <Ungroup className="w-4 h-4 mr-2" />Ungroup<DropdownMenuShortcut>⌘⇧G</DropdownMenuShortcut>
            </DropdownMenuItem>
            {/* PHASE 6: boolean operations + mask */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]">
                <Square className="w-4 h-4 mr-2" />Boolean Operations
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)] min-w-[180px]">
                {(['union', 'subtract', 'intersect', 'exclude'] as const).map((op) => (
                  <DropdownMenuItem key={op} className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => {
                    const s = useEditorStore.getState()
                    if (s.selectedElementIds.length < 2) {
                      toast({ title: 'Boolean operation failed', description: 'Select at least 2 vector shapes (rectangle/ellipse/polygon/star/path)', variant: 'destructive' })
                      return
                    }
                    s.pushHistory()
                    const res = s.applyBooleanOperation(op)
                    if (!res.ok) toast({ title: 'Boolean operation failed', description: res.reason, variant: 'destructive' })
                  }}>
                    {op === 'union' ? 'Union' : op === 'subtract' ? 'Subtract' : op === 'intersect' ? 'Intersect' : 'Exclude'}
                    <DropdownMenuShortcut>⌥⌘{op === 'union' ? 'U' : op === 'subtract' ? 'S' : op === 'intersect' ? 'I' : 'E'}</DropdownMenuShortcut>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => {
              const s = useEditorStore.getState()
              if (s.selectedElementIds.length !== 1) return
              const el = findElementInList(s.elements, s.selectedElementIds[0])
              if (el && isBooleanOperandType(el)) { s.pushHistory(); s.setElementAsMask(el.id, !el.isMask) }
            }}>
              <Square className="w-4 h-4 mr-2" />Set as Mask / Unmask<DropdownMenuShortcut>⌃⌘M</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.selectedElementIds.forEach(id => s.bringForward(id)) }}>
              <ArrowUpToLine className="w-4 h-4 mr-2" />Bring Forward<DropdownMenuShortcut>⌘]</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.selectedElementIds.forEach(id => s.sendBackward(id)) }}>
              <ArrowDownToLine className="w-4 h-4 mr-2" />Send Backward<DropdownMenuShortcut>⌘[</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.selectedElementIds.forEach(id => s.bringToFront(id)) }}>
              <BringToFront className="w-4 h-4 mr-2" />Bring to Front<DropdownMenuShortcut>⌘⌥]</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.selectedElementIds.forEach(id => s.sendToBack(id)) }}>
              <SendToBack className="w-4 h-4 mr-2" />Send to Back<DropdownMenuShortcut>⌘⌥[</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.selectedElementIds.forEach(id => s.flipHorizontal(id)) }}>
              <FlipHorizontal2 className="w-4 h-4 mr-2" />Flip Horizontal
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.selectedElementIds.forEach(id => s.flipVertical(id)) }}>
              <FlipVertical2 className="w-4 h-4 mr-2" />Flip Vertical
            </DropdownMenuItem>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]">
                Align
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)]">
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.alignElements(s.selectedElementIds, 'left') }}>
                  <AlignLeft className="w-4 h-4 mr-2" />Align Left
                </DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.alignElements(s.selectedElementIds, 'center-h') }}>
                  <AlignCenterHorizontal className="w-4 h-4 mr-2" />Align Center
                </DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.alignElements(s.selectedElementIds, 'right') }}>
                  <AlignRight className="w-4 h-4 mr-2" />Align Right
                </DropdownMenuItem>
                <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.alignElements(s.selectedElementIds, 'top') }}>
                  <AlignStartVertical className="w-4 h-4 mr-2" />Align Top
                </DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.alignElements(s.selectedElementIds, 'center-v') }}>
                  <AlignCenterVertical className="w-4 h-4 mr-2" />Align Middle
                </DropdownMenuItem>
                <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.alignElements(s.selectedElementIds, 'bottom') }}>
                  <AlignEndVertical className="w-4 h-4 mr-2" />Align Bottom
                </DropdownMenuItem>
              </DropdownMenuSubContent>
            </DropdownMenuSub>
            <DropdownMenuSeparator className="bg-[color:var(--dc-hover)]" />
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.distributeElements(s.selectedElementIds, 'horizontal') }}>
              <Space className="w-4 h-4 mr-2" />Distribute Horizontal Spacing
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => { const s = useEditorStore.getState(); s.pushHistory(); s.distributeElements(s.selectedElementIds, 'vertical') }}>
              <Space className="w-4 h-4 mr-2 rotate-90" />Distribute Vertical Spacing
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="flex items-center h-6 px-2 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-text2)] text-[11px] transition-colors duration-100">Tools</button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)] min-w-[200px]">
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('move')}>
              <MousePointer2 className="w-4 h-4 mr-2" />Move<DropdownMenuShortcut>V</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('frame')}>
              <Frame className="w-4 h-4 mr-2" />Frame<DropdownMenuShortcut>F</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('rectangle')}>
              <Square className="w-4 h-4 mr-2" />Rectangle<DropdownMenuShortcut>R</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('ellipse')}>
              <Circle className="w-4 h-4 mr-2" />Ellipse<DropdownMenuShortcut>O</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('line')}>
              <Spline className="w-4 h-4 mr-2" />Line<DropdownMenuShortcut>L</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('arrow')}>
              <MoveRight className="w-4 h-4 mr-2" />Arrow<DropdownMenuShortcut>⇧L</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('pen')}>
              <Pen className="w-4 h-4 mr-2" />Pen<DropdownMenuShortcut>P</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('text')}>
              <Type className="w-4 h-4 mr-2" />Text<DropdownMenuShortcut>T</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('hand')}>
              <Hand className="w-4 h-4 mr-2" />Hand<DropdownMenuShortcut>H</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuItem className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)]" onClick={() => useEditorStore.getState().setActiveTool('eyedropper')}>
              <Pipette className="w-4 h-4 mr-2" />Eyedropper<DropdownMenuShortcut>I</DropdownMenuShortcut>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        {/* File name */}
        <div className="flex items-center gap-1 ml-1">
          {isEditingName ? (
            <input autoFocus value={fileName} onChange={(e) => setFileName(e.target.value)} onBlur={() => setIsEditingName(false)} onKeyDown={(e) => { if (e.key === 'Enter') setIsEditingName(false) }} className="h-5 px-1.5 text-[11px] bg-[color:var(--dc-input)] border border-[color:var(--dc-accent)] rounded text-white outline-none w-[120px]" />
          ) : (
            <button onDoubleClick={() => setIsEditingName(true)} className="flex items-center gap-1 h-6 px-2 rounded hover:bg-[color:var(--dc-hover)] text-white text-[11px] font-medium transition-colors duration-100">
              {fileName}
              <ChevronDown className="w-2.5 h-2.5 text-[color:var(--dc-muted)]" />
            </button>
          )}
        </div>

        {/* Live-sync indicator (SSE) — only when a server project is open */}
        {currentProjectId && (
          <span
            className="text-[9px] flex items-center gap-0.5"
            title={
              syncStatus === 'live'
                ? `Live sync active — remote changes appear instantly${lastRemoteOrigin ? ` (last change by ${lastRemoteOrigin})` : ''}`
                : syncStatus === 'connecting'
                  ? 'Connecting live-sync stream…'
                  : 'Live sync offline'
            }
          >
            {syncStatus === 'live' ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-[#2ED573] animate-pulse" />
                <span className="text-[#2ED573]">Live</span>
              </>
            ) : syncStatus === 'connecting' ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-[#FFB800] animate-pulse" />
                <span className="text-[#FFB800]">Sync…</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--dc-faint)]" />
                <span className="text-[color:var(--dc-faint)]">Offline</span>
              </>
            )}
          </span>
        )}

        {/* Save indicator */}
        <div className="flex items-center gap-1 ml-1">
          {isSaving ? (
            <span className="text-[9px] text-[color:var(--dc-accent)] animate-pulse">Saving...</span>
          ) : showSaveIndicator ? (
            <span className="text-[9px] text-[#2ED573] flex items-center gap-0.5">
              <Check className="w-2.5 h-2.5" />
              Saved
            </span>
          ) : isDirty ? (
            <span className="text-[9px] text-[color:var(--dc-muted)] flex items-center gap-0.5" title={formatSaveTime(lastSavedAt)}>
              <CloudOff className="w-2.5 h-2.5" />
              Unsaved
            </span>
          ) : lastSavedAt ? (
            <span className="text-[9px] text-[color:var(--dc-faint)]" title={formatSaveTime(lastSavedAt)}>
              {formatSaveTime(lastSavedAt)}
            </span>
          ) : null}
        </div>
      </div>

      {/* Center section */}
      <div className="flex items-center gap-1">
        <button onClick={() => undo()} className="flex items-center justify-center w-6 h-6 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-muted)] hover:text-white transition-colors duration-100" title="Undo (Ctrl+Z)">
          <Undo2 className="w-3 h-3" />
        </button>
        <button onClick={() => redo()} className="flex items-center justify-center w-6 h-6 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-muted)] hover:text-white transition-colors duration-100" title="Redo (Ctrl+Shift+Z)">
          <Redo2 className="w-3 h-3" />
        </button>
      </div>

      {/* Right section */}
      <div className="flex items-center gap-1.5">
        <button className="flex items-center gap-1 bg-[color:var(--dc-accent)] hover:bg-[color:var(--dc-accent-hover)] text-white text-[11px] font-medium px-2.5 py-1 rounded-md transition-colors duration-100">
          <Share2 className="w-3 h-3" />Share
        </button>

        {/* Zoom controls */}
        <div className="flex items-center gap-px ml-0.5">
          <button onClick={() => setZoom(zoom - 0.1)} className="flex items-center justify-center w-6 h-6 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-muted)] hover:text-white transition-colors duration-100" title="Zoom out">
            <Minus className="w-3 h-3" />
          </button>
          <button onClick={() => { setZoom(1); setPan(0, 0) }} className="flex items-center justify-center h-6 px-1 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-muted)] hover:text-white text-[11px] font-medium min-w-[38px] transition-colors duration-100 tabular-nums" title="Reset zoom">
            {Math.round(zoom * 100)}%
          </button>
          <button onClick={() => setZoom(zoom + 0.1)} className="flex items-center justify-center w-6 h-6 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-muted)] hover:text-white transition-colors duration-100" title="Zoom in">
            <Plus className="w-3 h-3" />
          </button>
          <button onClick={() => { const container = document.querySelector('[class*="bg-[color:var(--dc-input)]"]'); if (container) { const rect = container.getBoundingClientRect(); const state = useEditorStore.getState(); let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity; const processEl = (el: DesignElement, parentX = 0, parentY = 0) => { const absX = el.x + parentX; const absY = el.y + parentY; minX = Math.min(minX, absX); minY = Math.min(minY, absY); maxX = Math.max(maxX, absX + el.width); maxY = Math.max(maxY, absY + el.height); el.children?.forEach(c => processEl(c, absX, absY)) }; state.elements.forEach(el => processEl(el)); if (minX !== Infinity) { const cw = maxX - minX; const ch = maxY - minY; const pad = 100; const nz = Math.min((rect.width - pad * 2) / cw, (rect.height - pad * 2) / ch, 2); state.setZoom(nz); state.setPan(-(minX + cw / 2) * nz, -(minY + ch / 2) * nz) } } }} className="flex items-center justify-center w-6 h-6 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-muted)] hover:text-white transition-colors duration-100" title="Fit to screen">
            <Maximize2 className="w-3 h-3" />
          </button>
        </div>

        <button onClick={toggleRightSidebar} className="flex items-center justify-center w-6 h-6 rounded hover:bg-[color:var(--dc-hover)] text-[color:var(--dc-muted)] hover:text-white transition-colors duration-100 ml-0.5" title="Toggle right panel">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
            <line x1="11" y1="1" x2="11" y2="15" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
    </div>
  )
}
