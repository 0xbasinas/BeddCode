import { useEffect, useState } from 'react'
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Camera,
  ChevronRight,
  Clock,
  Code2,
  Eye,
  Globe,
  Keyboard,
  ListTree,
  Loader2,
  MousePointer2,
  MousePointerClick,
  MoveVertical,
  PanelTop,
  RotateCw,
  SquareMousePointer,
  Terminal,
  Type,
} from 'lucide-react'
import { browserToolView, type BrowserToolView, type Tool } from '@beddcode/client-runtime'
import type { BrowserToolName } from '@beddcode/contracts'
import { activeRoute, hostRequest } from '../../stores/host.ts'
import { httpBase } from '../files/mediaKind.ts'

const ICON: Record<BrowserToolName, typeof Globe> = {
  browser_tabs: PanelTop,
  browser_navigate: Globe,
  browser_back: ArrowLeft,
  browser_forward: ArrowRight,
  browser_reload: RotateCw,
  browser_snapshot: ListTree,
  browser_click: MousePointerClick,
  browser_type: Type,
  browser_press_key: Keyboard,
  browser_hover: MousePointer2,
  browser_select_option: SquareMousePointer,
  browser_scroll: MoveVertical,
  browser_wait_for: Clock,
  browser_screenshot: Camera,
  browser_console: Terminal,
  browser_evaluate: Code2,
}

/** A picture the host saved (absolute path), shown through the host's media links. */
function HostImage({
  hostKey,
  path,
  className,
  onClick,
}: {
  hostKey?: string
  path: string
  className?: string
  onClick?(): void
}) {
  const [src, setSrc] = useState<string>()
  useEffect(() => {
    if (!hostKey) return
    let live = true
    const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
    hostRequest(hostKey, 'files.media', {
      cwd: path.slice(0, cut) || '/',
      path: path.slice(cut + 1),
    })
      .then((m) => {
        const route = activeRoute(hostKey)
        if (live && m && route) setSrc(`${httpBase(route)}${m.url}`)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [hostKey, path])
  if (!src) return <span className={`browser-thumb placeholder ${className ?? ''}`} />
  return (
    <img
      className={`browser-thumb ${className ?? ''}`}
      src={src}
      alt="The page after this step"
      onClick={onClick}
    />
  )
}

function hostOf(url: string) {
  try {
    const u = new URL(url)
    return u.host + (u.pathname === '/' ? '' : u.pathname)
  } catch {
    return url
  }
}

function Row({ tool, view, hostKey }: { tool: Tool; view: BrowserToolView; hostKey?: string }) {
  const [open, setOpen] = useState(false)
  const Icon = ICON[view.name]
  const running = tool.status === 'running'
  const expandable = Boolean(view.detail) || Boolean(view.image)
  return (
    <div className={`browser-row ${tool.status}`}>
      <button
        type="button"
        className="browser-row-head"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((o) => !o)}
      >
        {running ? (
          <Loader2 size={13} className="spin browser-row-icon" />
        ) : view.failed ? (
          <AlertTriangle size={13} className="browser-row-icon danger" />
        ) : (
          <Icon size={13} className="browser-row-icon" />
        )}
        <span className="browser-row-text">{view.summary}</span>
        {view.image && <Eye size={12} className="browser-row-pic" aria-label="has a picture" />}
        {expandable && <ChevronRight size={12} className="agent-card-chevron" />}
      </button>
      {view.failed && !open && view.detail && (
        <div className="browser-row-error">{view.detail.split('\n')[0]}</div>
      )}
      {open && (
        <div className="browser-row-body">
          {view.image && <HostImage hostKey={hostKey} path={view.image} className="large" />}
          {view.detail && <pre>{view.detail}</pre>}
        </div>
      )}
    </div>
  )
}

/**
 * A run of browser steps by the agent: one card that names the page, lists each step in plain
 * words, and shows a small picture of the page after the latest step.
 */
export function BrowserToolCard({ tools, hostKey }: { tools: Tool[]; hostKey?: string }) {
  const views = tools.map((t) => browserToolView(t)!)
  const [big, setBig] = useState(false)
  const running = tools.some((t) => t.status === 'running')
  const page = [...views].reverse().find((v) => v.page)?.page
  const latest = [...views].reverse().find((v) => v.image)?.image
  const failed = views.filter((v) => v.failed).length
  return (
    <div className={`agent-card browser-card ${running ? 'running' : ''}`}>
      <div className="agent-card-head">
        <Globe size={14} className="agent-card-icon browser-card-icon" />
        <span className="agent-card-title">
          <strong>Browser</strong>
          {page && (
            <span className="agent-card-name" title={page.url}>
              {' '}
              · {page.title ? `${page.title} — ` : ''}
              {hostOf(page.url)}
            </span>
          )}
        </span>
        <span className="browser-card-count">
          {tools.length} step{tools.length === 1 ? '' : 's'}
          {failed ? ` · ${failed} failed` : ''}
        </span>
      </div>
      <div className={`browser-card-body ${latest ? 'with-thumb' : ''}`}>
        <div className="browser-rows">
          {tools.map((t, i) => (
            <Row key={t.id} tool={t} view={views[i]!} hostKey={hostKey} />
          ))}
        </div>
        {latest && (
          <HostImage
            hostKey={hostKey}
            path={latest}
            className={big ? 'latest big' : 'latest'}
            onClick={() => setBig((b) => !b)}
          />
        )}
      </div>
    </div>
  )
}
