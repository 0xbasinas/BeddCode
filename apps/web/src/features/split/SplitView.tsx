import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { ThreadView } from '../thread/ThreadView.tsx'
import { PaneContext, type PaneInfo } from './paneContext.ts'
import { SESSION_DRAG, dropEdge, placeSession, useSplit, type DropTarget } from './splitLayout.ts'

/** The session the address points at, if any. */
export function useRouteSession(): string | undefined {
  return useLocation({
    select: (location) => {
      const match = /^\/session\/([^/]+)$/.exec(location.pathname)
      return match ? decodeURIComponent(match[1]!) : undefined
    },
  })
}

/** The sessions showing, left to right; the first is the one in the address. */
export function useShownPanes(): string[] {
  const primary = useRouteSession()
  const side = useSplit((s) => s.side)
  return useMemo(
    () => (primary ? [primary, ...side.filter((id) => id !== primary)] : []),
    [primary, side],
  )
}

/** The session the side tools (Git, files, terminal) follow: the pane last used in a split. */
export function useFocusedSession(): string | undefined {
  const panes = useShownPanes()
  const focused = useSplit((s) => s.focused)
  return panes.length > 1 && focused && panes.includes(focused) ? focused : panes[0]
}

/** Changes which sessions show side by side; the first goes in the address. */
export function useArrangePanes() {
  const navigate = useNavigate()
  const primary = useRouteSession()
  return useCallback(
    (panes: string[]) => {
      const [first, ...rest] = panes
      useSplit.getState().setSide(rest)
      if (first && first !== primary) {
        void navigate({ to: '/session/$sessionId', params: { sessionId: first } })
      }
      if (first) useSplit.getState().setFocused(first)
    },
    [navigate, primary],
  )
}

/** Opens a session in a new pane on the right, beside what shows now. */
export function useOpenBeside() {
  const shown = useShownPanes()
  const arrange = useArrangePanes()
  return useCallback(
    (sessionId: string) => {
      arrange(
        placeSession(shown, sessionId, { index: Math.max(0, shown.length - 1), edge: 'right' }),
      )
      useSplit.getState().setFocused(sessionId)
    },
    [arrange, shown],
  )
}

interface Hover extends DropTarget {
  left: number
  top: number
  width: number
  height: number
}

/**
 * The main area: the routed screen, and on a session, any sessions opened beside it. A session
 * dragged here from the list opens in place of a pane (dropped in its middle) or beside it
 * (dropped near its left or right edge).
 */
export function SplitView() {
  const panes = useShownPanes()
  const arrange = useArrangePanes()
  const activeId = useFocusedSession()
  const root = useRef<HTMLDivElement>(null)
  const [hover, setHover] = useState<Hover>()
  const depth = useRef(0)

  const targetAt = (event: DragEvent): Hover | undefined => {
    const box = root.current?.getBoundingClientRect()
    if (!box) return undefined
    const cells = [...(root.current?.querySelectorAll<HTMLElement>('[data-split-index]') ?? [])]
    if (panes.length === 0 || cells.length === 0) {
      return { index: 0, edge: 'center', left: 0, top: 0, width: box.width, height: box.height }
    }
    const cell =
      cells.find((c) => {
        const r = c.getBoundingClientRect()
        return event.clientX >= r.left && event.clientX <= r.right
      }) ?? (event.clientX < box.left + box.width / 2 ? cells[0]! : cells[cells.length - 1]!)
    const r = cell.getBoundingClientRect()
    const index = Number(cell.dataset.splitIndex)
    const edge = dropEdge(event.clientX, r.left, r.width)
    const half = edge === 'center' ? r.width : r.width / 2
    return {
      index,
      edge,
      left: (edge === 'right' ? r.left + r.width / 2 : r.left) - box.left,
      top: r.top - box.top,
      width: half,
      height: r.height,
    }
  }

  const isSessionDrag = (event: DragEvent) => event.dataTransfer.types.includes(SESSION_DRAG)

  const onDragEnter = (event: DragEvent) => {
    if (!isSessionDrag(event)) return
    depth.current += 1
  }
  const onDragOver = (event: DragEvent) => {
    if (!isSessionDrag(event)) return
    // Ours, not the composer's file drop.
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = 'move'
    const next = targetAt(event)
    setHover((current) =>
      current &&
      next &&
      current.index === next.index &&
      current.edge === next.edge &&
      current.width === next.width
        ? current
        : next,
    )
  }
  const onDragLeave = (event: DragEvent) => {
    if (!isSessionDrag(event)) return
    depth.current = Math.max(0, depth.current - 1)
    if (depth.current === 0) setHover(undefined)
  }
  const onDrop = (event: DragEvent) => {
    if (!isSessionDrag(event)) return
    event.preventDefault()
    event.stopPropagation()
    depth.current = 0
    const sessionId = event.dataTransfer.getData(SESSION_DRAG)
    const target = targetAt(event)
    setHover(undefined)
    if (!sessionId || !target) return
    arrange(placeSession(panes, sessionId, target))
    useSplit.getState().setFocused(sessionId)
  }
  // A drag that ends anywhere else (Escape, outside the window) clears the hint.
  useEffect(() => {
    const clear = () => {
      depth.current = 0
      setHover(undefined)
    }
    document.addEventListener('dragend', clear)
    document.addEventListener('drop', clear)
    return () => {
      document.removeEventListener('dragend', clear)
      document.removeEventListener('drop', clear)
    }
  }, [])

  const split = panes.length > 1
  const info = (index: number, sessionId: string): PaneInfo => ({
    index,
    count: panes.length,
    active: sessionId === activeId,
    close: () => arrange(panes.filter((id) => id !== sessionId)),
    solo: () => arrange([sessionId]),
  })

  return (
    <div
      ref={root}
      className={`split-root ${hover ? 'split-dragging' : ''}`}
      onDragEnterCapture={onDragEnter}
      onDragOverCapture={onDragOver}
      onDragLeaveCapture={onDragLeave}
      onDropCapture={onDrop}
    >
      {split ? (
        <Group orientation="horizontal" className="split-group">
          {panes.map((sessionId, index) => (
            <Fragment key={sessionId}>
              {index > 0 && <Separator className="shell-sep" />}
              <Panel id={`pane-${sessionId}`} className="shell-panel" minSize="280px">
                <div
                  className={`split-pane ${sessionId === activeId ? 'active' : ''}`}
                  data-split-index={index}
                  data-session-id={sessionId}
                  onPointerDownCapture={() => useSplit.getState().setFocused(sessionId)}
                  onFocusCapture={() => useSplit.getState().setFocused(sessionId)}
                >
                  <PaneContext.Provider value={info(index, sessionId)}>
                    {index === 0 ? (
                      <Outlet />
                    ) : (
                      <ThreadView key={sessionId} sessionId={sessionId} />
                    )}
                  </PaneContext.Provider>
                </div>
              </Panel>
            </Fragment>
          ))}
        </Group>
      ) : (
        <div className="split-pane solo" data-split-index={panes.length ? 0 : undefined}>
          <Outlet />
        </div>
      )}
      {hover && (
        <div
          className={`split-drop ${hover.edge}`}
          style={{ left: hover.left, top: hover.top, width: hover.width, height: hover.height }}
          aria-hidden="true"
        >
          <span>
            {panes.length === 0 || hover.edge === 'center' ? 'Open here' : 'Open side by side'}
          </span>
        </div>
      )}
    </div>
  )
}
