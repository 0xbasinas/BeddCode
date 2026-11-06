// @ts-nocheck
import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react'
import { useEditorStore, type DesignElement } from '../../store/editor-store'
import { findElementInList, getAllElements } from '../../lib/element-utils'
import {
  Eye,
  EyeOff,
  ChevronRight,
  ChevronDown,
  Lock,
  Unlock,
  Component as ComponentIcon,
  Search,
  Filter,
} from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  ContextMenuShortcut,
} from '../ui/context-menu'
import { useShallow } from 'zustand/react/shallow'

const typeLabels: Record<string, string> = {
  frame: 'Frame',
  group: 'Group',
  rectangle: 'Rect',
  ellipse: 'Ellipse',
  line: 'Line',
  arrow: 'Arrow',
  text: 'Text',
  path: 'Path',
  polygon: 'Polygon',
  star: 'Star',
  boolean: 'Boolean',
  slice: 'Slice',
  // PHASE 15
  section: 'Section',
  table: 'Table',
  sticky: 'Sticky',
}

function getElementThumbnailColor(el: DesignElement): string {
  if (el.type === 'text') return el.textColor || '#000000'
  if (el.type === 'line' || el.type === 'arrow')
    return el.stroke === 'transparent' ? '#000000' : el.stroke
  if (el.type === 'path')
    return el.stroke === 'transparent'
      ? el.fill && el.fill !== 'transparent'
        ? el.fill
        : '#000000'
      : el.stroke
  if (el.fill && el.fill !== 'transparent') return el.fill
  if (el.fills && el.fills.length > 0 && el.fills[0].color && el.fills[0].color !== 'transparent')
    return el.fills[0].color
  return '#444444'
}

/* ── SVG-based shape thumbnails ───────────────────────────── */

function ShapeThumbnail({ element }: { element: DesignElement }) {
  const color = getElementThumbnailColor(element)
  const size = 14

  if (element.type === 'frame') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <rect
          x="1"
          y="1"
          width="12"
          height="12"
          rx="1.5"
          stroke={color}
          strokeWidth="1.2"
          fill="none"
        />
        <rect
          x="3"
          y="3"
          width="8"
          height="8"
          rx="0.5"
          stroke={color}
          strokeWidth="0.6"
          strokeDasharray="1.5 1"
          fill="none"
          opacity="0.5"
        />
      </svg>
    )
  }
  if (element.type === 'group') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <rect
          x="1"
          y="1"
          width="12"
          height="12"
          rx="1"
          stroke={color}
          strokeWidth="1"
          strokeDasharray="2 1.5"
          fill="none"
          opacity="0.7"
        />
      </svg>
    )
  }
  if (element.type === 'ellipse') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <ellipse
          cx="7"
          cy="7"
          rx="5.5"
          ry="5.5"
          fill={color}
          fillOpacity="0.35"
          stroke={color}
          strokeWidth="1.2"
        />
      </svg>
    )
  }
  if (element.type === 'line') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <line
          x1="2"
          y1="12"
          x2="12"
          y2="2"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (element.type === 'arrow') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <line
          x1="2"
          y1="12"
          x2="11"
          y2="3"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
        />
        <polyline
          points="6,2 11,3 10,8"
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (element.type === 'text') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <text
          x="7"
          y="11"
          textAnchor="middle"
          fontSize="10"
          fontWeight="700"
          fill={color}
          fontFamily="sans-serif"
        >
          T
        </text>
      </svg>
    )
  }
  if (element.type === 'star') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <path
          d="M7 1l1.8 4.2H13l-3.4 2.6 1.3 4.2L7 9.8 3.1 12l1.3-4.2L1 5.2h4.2z"
          fill={color}
          fillOpacity="0.35"
          stroke={color}
          strokeWidth="0.8"
        />
      </svg>
    )
  }
  if (element.type === 'polygon') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <path
          d="M7 1.5l5.1 3.7-1.9 6H3.8l-1.9-6z"
          fill={color}
          fillOpacity="0.35"
          stroke={color}
          strokeWidth="0.8"
        />
      </svg>
    )
  }
  if (element.type === 'path') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <path
          d="M2 10 C4 2, 10 12, 12 4"
          stroke={color}
          strokeWidth="1.3"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    )
  }
  if (element.type === 'slice') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <rect
          x="1"
          y="1"
          width="12"
          height="12"
          rx="1"
          stroke={color}
          strokeWidth="1"
          strokeDasharray="3 2"
          fill="none"
        />
        <line
          x1="1"
          y1="7"
          x2="13"
          y2="7"
          stroke={color}
          strokeWidth="0.6"
          strokeDasharray="1.5 1"
        />
      </svg>
    )
  }
  if (element.type === 'boolean') {
    return (
      <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
        <rect
          x="1"
          y="3"
          width="7"
          height="7"
          rx="0.5"
          fill={color}
          fillOpacity="0.25"
          stroke={color}
          strokeWidth="0.8"
        />
        <rect
          x="6"
          y="4"
          width="7"
          height="7"
          rx="0.5"
          fill={color}
          fillOpacity="0.15"
          stroke={color}
          strokeWidth="0.8"
        />
      </svg>
    )
  }
  // Default rectangle
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" fill="none">
      <rect
        x="1.5"
        y="2.5"
        width="11"
        height="9"
        rx="1.5"
        fill={color}
        fillOpacity="0.35"
        stroke={color}
        strokeWidth="1.2"
      />
    </svg>
  )
}

/* ── Dotted indent lines (Figma-style) ────────────────────── */

function IndentLines({ depth }: { depth: number }) {
  if (depth === 0) return null
  const lines: React.ReactNode[] = []
  for (let i = 0; i < depth; i++) {
    const left = i * 14 + 8
    lines.push(
      <div key={`indent-${i}`} className="absolute top-0 bottom-0" style={{ left: `${left}px` }}>
        <div
          className="w-px h-full"
          style={{
            backgroundImage:
              'linear-gradient(to bottom, #444 33%, transparent 33%, transparent 66%, #444 66%)',
            backgroundSize: '1px 3px',
          }}
        />
      </div>,
    )
  }
  return <>{lines}</>
}

/* ── LayerItem ────────────────────────────────────────────── */

/** Height of one layer row, in px: the list is windowed on it. */
const ROW_HEIGHT = 28

/**
 * One row of the flattened layer tree. Memoized on plain values, so while an element is dragged
 * only the rows of the elements that actually changed render again.
 */
const LayerItem = React.memo(function LayerItem({
  element,
  depth,
  isSelected,
  isHovered,
  isExpanded,
  onToggleExpand,
  onContextMenuAction,
  onHoverLayer,
}: {
  element: DesignElement
  depth: number
  isSelected: boolean
  isHovered: boolean
  isExpanded: boolean
  onToggleExpand: (id: string) => void
  onContextMenuAction: (action: string, elementId: string) => void
  onHoverLayer: (id: string | null) => void
}) {
  const { updateElement, setSelectedElementIds } = useEditorStore.getState()
  const [isRenaming, setIsRenaming] = useState(false)
  const [renameValue, setRenameValue] = useState(element.name)
  const [isDragOver, setIsDragOver] = useState(false)

  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (e.shiftKey) {
      useEditorStore.getState().toggleElementSelection(element.id)
    } else {
      setSelectedElementIds([element.id])
    }
  }

  const toggleVisibility = (e: React.MouseEvent) => {
    e.stopPropagation()
    updateElement(element.id, { visible: !element.visible })
  }

  const toggleLocked = (e: React.MouseEvent) => {
    e.stopPropagation()
    updateElement(element.id, { locked: !element.locked })
  }

  const toggleExpand = (e: React.MouseEvent) => {
    e.stopPropagation()
    onToggleExpand(element.id)
  }

  const handleRename = () => {
    if (renameValue.trim()) updateElement(element.id, { name: renameValue.trim() })
    setIsRenaming(false)
  }

  // Drag-to-reorder
  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation()
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', element.id)
  }

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
    setIsDragOver(true)
  }

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation()
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const draggedId = e.dataTransfer.getData('text/plain')
    if (draggedId && draggedId !== element.id) {
      const state = useEditorStore.getState()
      const dropIdx = state.elements.findIndex((el) => el.id === element.id)
      if (dropIdx >= 0) {
        state.reorderElement(draggedId, dropIdx)
      }
    }
  }

  const hasChildren = element.children && element.children.length > 0
  const childCount = element.children?.length ?? 0

  const rowContent = (
    <div
      className={`flex items-center h-[28px] cursor-pointer group text-[11px] relative select-none ${
        isSelected
          ? 'bg-[color:var(--dc-accent)]/15 text-white'
          : isHovered
            ? 'bg-[color:var(--dc-card)] text-[color:var(--dc-text2)]'
            : isDragOver
              ? 'bg-[color:var(--dc-accent)]/10'
              : 'text-[color:var(--dc-text2)]'
      } ${!element.visible ? 'opacity-50' : ''}`}
      style={{
        paddingLeft: `${depth * 14 + 4}px`,
        paddingRight: '2px',
        transition: 'background-color 100ms ease, color 100ms ease, opacity 100ms ease',
      }}
      onClick={handleClick}
      onMouseEnter={() => onHoverLayer(element.id)}
      onMouseLeave={() => onHoverLayer(null)}
      draggable={!element.locked}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Dotted indent lines */}
      <IndentLines depth={depth} />

      {/* Expand/collapse toggle */}
      {hasChildren ? (
        <button
          onClick={toggleExpand}
          className="flex items-center justify-center w-3.5 h-3.5 shrink-0 mr-px rounded-sm transition-colors duration-100 hover:bg-[color:var(--dc-hover)]"
        >
          {isExpanded ? (
            <ChevronDown className="w-2.5 h-2.5 text-[color:var(--dc-muted)]" />
          ) : (
            <ChevronRight className="w-2.5 h-2.5 text-[color:var(--dc-muted)]" />
          )}
        </button>
      ) : (
        <span className="w-[14px] shrink-0" />
      )}

      {/* Component / instance icon */}
      {element.isComponent ? (
        <ComponentIcon className="w-3 h-3 mr-0.5 text-[color:var(--dc-component)] shrink-0" />
      ) : element.componentId ? (
        <div className="w-3 h-3 mr-0.5 shrink-0 border border-[color:var(--dc-component)] rounded-[2px]" />
      ) : null}

      {/* Shape thumbnail */}
      <div className="shrink-0 mr-1 flex items-center justify-center w-[14px] h-[14px]">
        <ShapeThumbnail element={element} />
      </div>

      {/* Name */}
      {isRenaming ? (
        <input
          autoFocus
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRename()
            if (e.key === 'Escape') setIsRenaming(false)
            e.stopPropagation()
          }}
          className="flex-1 h-4 px-1 text-[10px] bg-[color:var(--dc-input)] border border-[color:var(--dc-accent)] rounded text-[color:var(--dc-text2)] outline-none min-w-0"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span
          className={`truncate flex-1 text-[11px] leading-none ${
            !element.visible
              ? 'text-[color:var(--dc-border-strong)] line-through'
              : isSelected
                ? 'text-white'
                : 'text-[color:var(--dc-text2)]'
          }`}
        >
          {element.name}
        </span>
      )}

      {/* Child count badge */}
      {hasChildren && !isRenaming && (
        <span className="text-[9px] text-[color:var(--dc-border-strong)] mr-0.5 shrink-0 tabular-nums font-medium leading-none">
          {childCount}
        </span>
      )}

      {/* Type label for Frame/Group */}
      {(element.type === 'frame' || element.type === 'group' || element.type === 'section') &&
        !hasChildren &&
        !isRenaming && (
          <span className="text-[8px] text-[color:var(--dc-border-strong)] mr-0.5 shrink-0 leading-none">
            {typeLabels[element.type] || ''}
          </span>
        )}

      {/* Lock toggle */}
      <button
        onClick={toggleLocked}
        className={`flex items-center justify-center w-4 h-4 shrink-0 transition-opacity duration-100 ${
          element.locked ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
        }`}
      >
        {element.locked ? (
          <Lock className="w-2.5 h-2.5 text-[color:var(--dc-danger)]" />
        ) : (
          <Unlock className="w-2.5 h-2.5 text-[color:var(--dc-faint)]" />
        )}
      </button>

      {/* Visibility toggle */}
      <button
        onClick={toggleVisibility}
        className={`flex items-center justify-center w-4 h-4 shrink-0 transition-opacity duration-100 ${
          element.visible ? 'opacity-0 group-hover:opacity-100' : 'opacity-100'
        }`}
      >
        {element.visible ? (
          <Eye className="w-2.5 h-2.5 text-[color:var(--dc-faint)]" />
        ) : (
          <EyeOff className="w-2.5 h-2.5 text-[color:var(--dc-danger)]" />
        )}
      </button>
    </div>
  )

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{rowContent}</ContextMenuTrigger>
        <ContextMenuContent className="bg-[color:var(--dc-raised)] border-[color:var(--dc-hover)] text-[color:var(--dc-text2)] min-w-[180px]">
          <ContextMenuItem
            className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6"
            onClick={() => onContextMenuAction('duplicate', element.id)}
          >
            Duplicate <ContextMenuShortcut>⌘D</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6"
            onClick={() => {
              onContextMenuAction('rename', element.id)
              setIsRenaming(true)
            }}
          >
            Rename
          </ContextMenuItem>
          <ContextMenuSeparator className="bg-[color:var(--dc-hover)]" />
          <ContextMenuItem
            className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6"
            onClick={() => onContextMenuAction('bring-forward', element.id)}
          >
            Bring Forward <ContextMenuShortcut>⌘]</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6"
            onClick={() => onContextMenuAction('send-backward', element.id)}
          >
            Send Backward <ContextMenuShortcut>⌘[</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuItem
            className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6"
            onClick={() => onContextMenuAction('bring-to-front', element.id)}
          >
            Bring to Front
          </ContextMenuItem>
          <ContextMenuItem
            className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6"
            onClick={() => onContextMenuAction('send-to-back', element.id)}
          >
            Send to Back
          </ContextMenuItem>
          <ContextMenuSeparator className="bg-[color:var(--dc-hover)]" />
          <ContextMenuItem
            className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6"
            onClick={() => onContextMenuAction('select-all-same', element.id)}
          >
            Select All Same Type
          </ContextMenuItem>
          {!element.isComponent && (
            <ContextMenuItem
              className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6"
              onClick={() => onContextMenuAction('make-component', element.id)}
            >
              Make Component <ContextMenuShortcut>⌥⌘K</ContextMenuShortcut>
            </ContextMenuItem>
          )}
          {element.isComponent && (
            <ContextMenuItem
              className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6"
              onClick={() => onContextMenuAction('create-instance', element.id)}
            >
              Create Instance
            </ContextMenuItem>
          )}
          <ContextMenuSeparator className="bg-[color:var(--dc-hover)]" />
          <ContextMenuItem
            className="hover:bg-[color:var(--dc-hover)] focus:bg-[color:var(--dc-hover)] text-[11px] h-6 text-[color:var(--dc-danger)]"
            onClick={() => onContextMenuAction('delete', element.id)}
          >
            Delete <ContextMenuShortcut>⌫</ContextMenuShortcut>
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </>
  )
})

/* ── LayerPanel ───────────────────────────────────────────── */

export function LayerPanel() {
  const {
    elements,
    deleteElement,
    duplicateElement,
    bringForward,
    sendBackward,
    bringToFront,
    sendToBack,
    setSelectedElementIds,
    pushHistory,
    addComponent,
    createInstance,
  } = useEditorStore(
    useShallow((s) => ({
      elements: s.elements,
      deleteElement: s.deleteElement,
      duplicateElement: s.duplicateElement,
      bringForward: s.bringForward,
      sendBackward: s.sendBackward,
      bringToFront: s.bringToFront,
      sendToBack: s.sendToBack,
      setSelectedElementIds: s.setSelectedElementIds,
      pushHistory: s.pushHistory,
      addComponent: s.addComponent,
      createInstance: s.createInstance,
    })),
  )
  const [searchQuery, setSearchQuery] = useState('')
  const [filterType, setFilterType] = useState('all')
  const [hoveredLayerId, setHoveredLayerId] = useState<string | null>(null)
  const selectedElementIds = useEditorStore((s) => s.selectedElementIds)
  const selectedSet = useMemo(() => new Set(selectedElementIds), [selectedElementIds])

  // Groups start expanded, so only the collapsed ones are remembered.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const toggleExpand = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(id)) next.add(id)
      return next
    })
  }, [])

  // The tree as one list of visible rows, so only the rows in view have to exist in the DOM.
  const rows = useMemo(() => {
    const out: { element: DesignElement; depth: number }[] = []
    const query = searchQuery.toLowerCase()
    const visit = (el: DesignElement, depth: number) => {
      if (
        filterType !== 'all' &&
        el.type !== filterType &&
        !el.children?.some((c) => c.type === filterType)
      )
        return
      if (
        query &&
        !el.name.toLowerCase().includes(query) &&
        !el.children?.some((c) => c.name.toLowerCase().includes(query))
      )
        return
      out.push({ element: el, depth })
      if (el.children?.length && !collapsed.has(el.id))
        for (const child of el.children) visit(child, depth + 1)
    }
    for (let i = elements.length - 1; i >= 0; i--) visit(elements[i]!, 0)
    return out
  }, [elements, collapsed, searchQuery, filterType])

  const scrollRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ top: 0, height: 600 })
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const read = () =>
      setView((v) =>
        v.top === el.scrollTop && v.height === el.clientHeight
          ? v
          : { top: el.scrollTop, height: el.clientHeight },
      )
    read()
    el.addEventListener('scroll', read, { passive: true })
    const resize = new ResizeObserver(read)
    resize.observe(el)
    return () => {
      el.removeEventListener('scroll', read)
      resize.disconnect()
    }
  }, [])
  const OVERSCAN = 8
  const firstRow = Math.max(0, Math.floor(view.top / ROW_HEIGHT) - OVERSCAN)
  const lastRow = Math.min(rows.length, Math.ceil((view.top + view.height) / ROW_HEIGHT) + OVERSCAN)

  const handleContextMenuAction = useCallback(
    (action: string, elementId: string) => {
      switch (action) {
        case 'delete':
          pushHistory()
          deleteElement(elementId)
          break
        case 'duplicate':
          pushHistory()
          duplicateElement(elementId)
          break
        case 'rename':
          break
        case 'bring-forward':
          pushHistory()
          bringForward(elementId)
          break
        case 'send-backward':
          pushHistory()
          sendBackward(elementId)
          break
        case 'bring-to-front':
          pushHistory()
          bringToFront(elementId)
          break
        case 'send-to-back':
          pushHistory()
          sendToBack(elementId)
          break
        case 'select-all-same':
          const el = findElementInList(useEditorStore.getState().elements, elementId)
          if (el) {
            const allEls = getAllElements(useEditorStore.getState().elements)
            const sameTypeIds = allEls.filter((e) => e.type === el.type).map((e) => e.id)
            setSelectedElementIds(sameTypeIds)
          }
          break
        case 'make-component':
          pushHistory()
          addComponent(elementId)
          break
        case 'create-instance':
          pushHistory()
          createInstance(elementId)
          break
      }
    },
    [
      deleteElement,
      duplicateElement,
      bringForward,
      sendBackward,
      bringToFront,
      sendToBack,
      pushHistory,
      setSelectedElementIds,
      addComponent,
      createInstance,
    ],
  )

  const filterTypes = [
    { value: 'all', label: 'All' },
    { value: 'frame', label: 'Frames' },
    { value: 'group', label: 'Groups' },
    { value: 'rectangle', label: 'Rects' },
    { value: 'ellipse', label: 'Ellipses' },
    { value: 'text', label: 'Text' },
    { value: 'line', label: 'Lines' },
    { value: 'arrow', label: 'Arrows' },
    { value: 'path', label: 'Paths' },
    { value: 'star', label: 'Stars' },
    { value: 'polygon', label: 'Polygons' },
  ]

  // Count total visible elements
  const totalLayers = elements.length

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-2 h-5 border-b border-[color:var(--dc-border)] shrink-0">
        <span className="text-[10px] font-semibold text-[color:var(--dc-muted)] uppercase tracking-wider">
          Layers
        </span>
        <span className="text-[9px] text-[color:var(--dc-border-strong)] tabular-nums">
          {totalLayers}
        </span>
      </div>

      {/* Search/Filter bar - single compact row */}
      <div className="px-1 py-0.5 border-b border-[color:var(--dc-border)] shrink-0">
        <div className="flex items-center gap-0.5">
          <div className="flex items-center flex-1 h-[18px] px-1 bg-[color:var(--dc-input)] border border-[color:var(--dc-border)] rounded-sm">
            <Search className="w-2 h-2 text-[color:var(--dc-border-strong)] shrink-0 mr-0.5" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter"
              className="flex-1 text-[10px] bg-transparent text-[color:var(--dc-text2)] placeholder-[color:var(--dc-border-strong)] focus:outline-none min-w-0"
            />
          </div>
          <div className="flex items-center h-[18px] pl-1 pr-0.5 bg-[color:var(--dc-input)] border border-[color:var(--dc-border)] rounded-sm">
            <Filter className="w-2 h-2 text-[color:var(--dc-border-strong)] shrink-0 mr-0.5" />
            <select
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
              className="text-[9px] bg-transparent text-[color:var(--dc-text2)] focus:outline-none appearance-none cursor-pointer"
            >
              {filterTypes.map((ft) => (
                <option key={ft.value} value={ft.value}>
                  {ft.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Layer list with smooth scrolling */}
      <div
        className="flex-1 overflow-y-auto"
        style={{
          scrollbarWidth: 'thin',
          scrollbarColor: 'var(--dc-active) transparent',
        }}
      >
        <style>{`
          .layer-scroll::-webkit-scrollbar { width: 4px; }
          .layer-scroll::-webkit-scrollbar-track { background: transparent; }
          .layer-scroll::-webkit-scrollbar-thumb { background: var(--dc-active); border-radius: 2px; }
          .layer-scroll::-webkit-scrollbar-thumb:hover { background: var(--dc-hover); }
          .layer-scroll::-webkit-scrollbar-corner { background: transparent; }
        `}</style>
        <div ref={scrollRef} className="layer-scroll h-full overflow-y-auto">
          <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
            <div
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${firstRow * ROW_HEIGHT}px)`,
              }}
            >
              {rows.slice(firstRow, lastRow).map(({ element, depth }) => (
                <LayerItem
                  key={element.id}
                  element={element}
                  depth={depth}
                  isSelected={selectedSet.has(element.id)}
                  isHovered={hoveredLayerId === element.id}
                  isExpanded={!collapsed.has(element.id)}
                  onToggleExpand={toggleExpand}
                  onContextMenuAction={handleContextMenuAction}
                  onHoverLayer={setHoveredLayerId}
                />
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
