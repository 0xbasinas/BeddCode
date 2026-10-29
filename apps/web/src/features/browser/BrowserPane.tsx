import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  Bug,
  Hand,
  Play,
  Square,
  Camera,
  Check,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Globe,
  Info,
  MoreHorizontal,
  MousePointer2,
  Plus,
  RotateCw,
  Search,
  Terminal,
  Trash2,
  TriangleAlert,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import type { BrowserConsoleEntry, BrowserPageState } from '@beddcode/contracts'
import {
  agentKey,
  browserCommand,
  nativeBrowser,
  pauseAgent,
  resumeAgent,
  useBrowser,
  type BrowserPrompt,
  type BrowserTab,
} from './browserStore.ts'
import { useNativeLayout } from './nativeView.ts'
import { previewTarget } from './preview.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { attachUpload, stageAttachment } from '../composer/attachments.ts'
import { hostRequest, interrupt, useHostStore } from '../../stores/host.ts'
import { Dropdown } from '../../ui/Dropdown.tsx'
import {
  CANCEL_PICK_SCRIPT,
  elementContext,
  normalizeUrl,
  pickElement,
  PICK_ELEMENT_SCRIPT,
  type PickedElement,
} from '@beddcode/client-runtime'

type Page = Partial<BrowserPageState>
const IDLE: Page = {}

const PERMISSION_TEXT: Record<string, string> = {
  media: 'use your camera or microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  midi: 'use MIDI devices',
}

function permissionText(p: Extract<BrowserPrompt, { type: 'permission' }>): string {
  if (p.permission === 'media' && p.mediaTypes?.length) {
    const devices = p.mediaTypes.map((m) => (m === 'video' ? 'camera' : 'microphone'))
    return `use your ${devices.join(' and ')}`
  }
  return PERMISSION_TEXT[p.permission] ?? `use ${p.permission}`
}

const dataUrlBase64 = (url: string) => url.slice(url.indexOf(',') + 1)

/** A small tabbed browser for previewing the app an agent is building. */
export function BrowserPane({
  draftId,
  project,
}: {
  draftId?: string
  /** The session's project, which screenshots and picked elements are attached to. */
  project?: { label: string; title: string }
}) {
  const hostKey = useHostKey()
  const { tabs, active, open, close, activate, pages, prompts, requests } = useBrowser()
  const current = tabs.find((t) => t.id === active)
  const page = (current && pages[current.id]) || IDLE
  const desktop = Boolean(nativeBrowser())
  const blank = !current || current.url === 'about:blank'
  const [address, setAddress] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [goError, setGoError] = useState<string>()
  const frame = useRef<HTMLIFrameElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string>()
  const picker = useRef<{ cancel(): void } | null>(null)
  const [finding, setFinding] = useState(false)
  const [consoleOpen, setConsoleOpen] = useState(false)

  useEffect(() => {
    setPicking(false)
    setPickError(undefined)
    return () => {
      picker.current?.cancel()
      picker.current = null
    }
  }, [current?.id, current?.url, hostKey, draftId, reloadKey])

  // Ctrl+F / Ctrl+L pressed inside a page come here (the page itself never sees them).
  const firstRequests = useRef(requests)
  useEffect(() => {
    if (requests.find !== firstRequests.current.find) setFinding(true)
  }, [requests.find])
  useEffect(() => {
    if (requests.address !== firstRequests.current.address) {
      addressInput.current?.focus()
      addressInput.current?.select()
    }
  }, [requests.address])

  // Focus can still be on the toolbar while the pointer moves into the guest page.
  useEffect(() => {
    if (!picking) return
    const cancelOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopImmediatePropagation()
      picker.current?.cancel()
      picker.current = null
      setPicking(false)
    }
    document.addEventListener('keydown', cancelOnEscape, true)
    return () => document.removeEventListener('keydown', cancelOnEscape, true)
  }, [picking])

  const pick = async () => {
    if (picker.current) {
      picker.current.cancel()
      picker.current = null
      setPicking(false)
      return
    }
    if (!draftId || !current) return
    setPickError(undefined)
    const tabId = current.id
    let cancelled = false
    let doc: Document | undefined
    const request = {
      cancel: () => {
        cancelled = true
        if (desktop) void browserCommand({ op: 'exec', tabId, code: CANCEL_PICK_SCRIPT })
        else doc?.dispatchEvent(new Event('beddcode:cancel-element-picker'))
      },
    }
    picker.current = request
    setPicking(true)
    try {
      let element: PickedElement | null | undefined
      if (desktop) {
        void browserCommand({ op: 'focus', tabId })
        element = (await nativeBrowser()!.command({
          op: 'exec',
          tabId,
          code: PICK_ELEMENT_SCRIPT,
        })) as PickedElement | null
      } else {
        // The browser's same-origin policy applies to iframe previews.
        try {
          doc = frame.current?.contentWindow?.document
        } catch {
          throw new Error(
            'Open this preview in the desktop app to pick elements from another origin.',
          )
        }
        if (!doc) throw new Error('Wait for the preview to load, then try again.')
        element = await pickElement(doc)
      }
      if (!element || cancelled) return
      void attachUpload(
        hostKey,
        draftId,
        new File([elementContext(element)], 'browser-element.txt', { type: 'text/plain' }),
      )
      if (desktop && element.rect.width > 0 && element.rect.height > 0) {
        const rect = element.rect
        // Reserve the screenshot chip now so Send waits for both attachments.
        void stageAttachment(hostKey, draftId, 'browser-element.png', 0, async () => {
          const image = await browserCommand<string>({ op: 'capture', tabId, rect })
          if (!image) throw new Error('Could not capture the element')
          return hostRequest(hostKey, 'attachments.upload', {
            name: 'browser-element.png',
            dataBase64: dataUrlBase64(image),
          })
        })
      }
    } catch (err) {
      if (!cancelled) setPickError(err instanceof Error ? err.message : 'Could not pick an element')
    } finally {
      if (picker.current === request) {
        picker.current = null
        setPicking(false)
      }
    }
  }

  /** Attaches a picture of the whole page to the message being written. */
  const screenshot = () => {
    if (!draftId || !current) return
    const tabId = current.id
    void stageAttachment(hostKey, draftId, 'browser-page.png', 0, async () => {
      const image = await browserCommand<string>({ op: 'capture', tabId })
      if (!image) throw new Error('Could not capture the page')
      return hostRequest(hostKey, 'attachments.upload', {
        name: 'browser-page.png',
        dataBase64: dataUrlBase64(image),
      })
    })
  }

  // In a plain browser, pages asking for a new window open in a tab (the desktop app's store
  // already listens for its pages).
  useEffect(() => {
    if (desktop) return
    return nativeBrowser()?.onOpen((url) => open(url, { newTab: true }))
  }, [open, desktop])

  // The address bar follows the active tab.
  useEffect(() => setAddress(current?.url ?? ''), [current?.id, current?.url])

  const go = async (text: string, newTab = false) => {
    const url = normalizeUrl(text)
    if (!url) return
    setGoError(undefined)
    try {
      const target = await previewTarget(hostKey, url)
      open(target.url, { newTab, via: target.via })
    } catch (err) {
      setGoError(err instanceof Error ? err.message : String(err))
    }
  }

  const reload = () => {
    if (!current) return
    if (desktop) void browserCommand({ op: page.loading ? 'stop' : 'reload', tabId: current.id })
    else setReloadKey((k) => k + 1)
  }

  const tabPrompts = prompts.filter((p) => p.tabId === undefined || p.tabId === current?.id)

  return (
    <div
      className="pane-body browser"
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f' && desktop && !blank) {
          e.preventDefault()
          setFinding(true)
        }
      }}
    >
      <div className="pane-head">
        <h2>Browser</h2>
        {project && (
          <span
            className="muted pane-project"
            title={`Screenshots and picked elements go to this session (${project.title})`}
          >
            {project.label}
          </span>
        )}
        <span className="spacer" />
        <button
          className="icon-btn"
          aria-label="New tab"
          onClick={() => open('about:blank', { newTab: true })}
        >
          <Plus size={18} />
        </button>
      </div>

      {tabs.length > 0 && (
        <div className="term-tabs" role="tablist">
          {tabs.map((t) => (
            <div key={t.id} className="term-tab" role="tab" aria-selected={t.id === active}>
              <button onClick={() => activate(t.id)} title={t.url}>
                <TabIcon tab={t} page={pages[t.id]} /> {t.title || t.url}
                {t.agent && (
                  <Bot size={13} className="tab-agent" aria-label={`${t.agent.label}'s tab`} />
                )}
              </button>
              <button aria-label={`Close ${t.title}`} onClick={() => close(t.id)}>
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        className="url-bar"
        onSubmit={(e) => {
          e.preventDefault()
          void go(address)
        }}
      >
        <button
          type="button"
          className={`icon-btn ${picking ? 'active' : ''}`}
          aria-label={picking ? 'Cancel element picker' : 'Pick element'}
          aria-pressed={picking}
          title={
            draftId
              ? 'Pick an element to attach to message'
              : 'Choose a folder to attach an element'
          }
          disabled={!draftId || blank}
          onClick={() => void pick()}
        >
          <MousePointer2 size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          disabled={!page.back}
          onClick={() => current && void browserCommand({ op: 'back', tabId: current.id })}
        >
          <ArrowLeft size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Forward"
          disabled={!page.forward}
          onClick={() => current && void browserCommand({ op: 'forward', tabId: current.id })}
        >
          <ArrowRight size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={page.loading ? 'Stop loading' : 'Reload'}
          disabled={!current}
          onClick={reload}
        >
          {page.loading ? <X size={16} /> : <RotateCw size={16} />}
        </button>
        <div className="url-field">
          <Globe size={15} />
          <input
            ref={addressInput}
            aria-label="Address"
            placeholder="Search or enter a URL"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
          {current?.via && (
            <span
              className="url-via"
              title={`Port ${current.via.port} on ${current.via.host}, forwarded to this computer`}
            >
              {current.via.host}:{current.via.port}
            </span>
          )}
          {desktop && page.zoom !== undefined && page.zoom !== 1 && current && (
            <button
              type="button"
              className="url-zoom"
              title="Reset zoom"
              onClick={() => void browserCommand({ op: 'zoom', tabId: current.id, direction: 0 })}
            >
              {Math.round(page.zoom * 100)}%
            </button>
          )}
        </div>
        {desktop && (
          <button
            type="button"
            className={`icon-btn console-btn ${consoleOpen ? 'active' : ''}`}
            aria-label="Console"
            aria-pressed={consoleOpen}
            title="Console"
            disabled={blank}
            onClick={() => setConsoleOpen((o) => !o)}
          >
            <Terminal size={16} />
            {!!page.consoleErrors && (
              <span className="badge-dot" aria-label={`${page.consoleErrors} errors`}>
                {page.consoleErrors > 99 ? '99+' : page.consoleErrors}
              </span>
            )}
          </button>
        )}
        {desktop && current && (
          <PageMenu
            tab={current}
            page={page}
            blank={blank}
            canAttach={Boolean(draftId)}
            onFind={() => setFinding(true)}
            onScreenshot={screenshot}
          />
        )}
      </form>

      {finding && current && desktop && (
        <FindBar
          tabId={current.id}
          found={page.found}
          focusKey={requests.find}
          onClose={() => setFinding(false)}
        />
      )}
      {tabPrompts.map((p) => (
        <PromptBanner key={p.id} prompt={p} />
      ))}
      {picking && (
        <div className="banner" role="status">
          Click an element to attach it. Press Escape to cancel.
        </div>
      )}
      {(pickError || goError) && (
        <div className="banner error" role="alert">
          {pickError ?? goError}
        </div>
      )}
      {page.unresponsive && current && (
        <div className="banner error" role="alert">
          This page is not responding.
          <button onClick={() => void browserCommand({ op: 'reload', tabId: current.id })}>
            Reload
          </button>
        </div>
      )}

      {current?.agent && <AgentBanner tab={current} />}
      {desktop && <NativePage tab={blank ? undefined : current} page={page} onRetry={reload} />}
      {!desktop && current && !blank && (
        <iframe
          ref={frame}
          key={`${current.id}:${current.url}:${reloadKey}`}
          className="page-frame"
          src={current.url}
          title={current.title}
          // Pages run without access to the app: no top navigation, no app storage.
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
          referrerPolicy="no-referrer"
        />
      )}
      {blank && (
        <div className="pane-empty">
          <span className="empty-icon">
            <Globe size={26} />
          </span>
          <h3>Nothing to preview</h3>
          <button
            className="primary-btn"
            onClick={() => void go(address || 'localhost:3000', tabs.length === 0)}
          >
            Open {address ? 'this URL' : 'localhost:3000'}
          </button>
          {!desktop && (
            <p className="muted small">
              Some sites refuse to be shown inside another page. The desktop app opens them in an
              isolated view.
            </p>
          )}
        </div>
      )}

      {consoleOpen && desktop && current && !blank && (
        <ConsoleDrawer
          tabId={current.id}
          errors={page.consoleErrors ?? 0}
          url={current.url}
          onAttach={
            draftId
              ? (text) =>
                  void attachUpload(
                    hostKey,
                    draftId,
                    new File([text], 'browser-console.txt', { type: 'text/plain' }),
                  )
              : undefined
          }
          onClose={() => setConsoleOpen(false)}
        />
      )}
      <Downloads />
    </div>
  )
}

/**
 * Shown over a tab an agent drives: who, and the user's controls. Take over pauses the agent's
 * browser use (its next browser call is told the user has the browser); Stop also ends its turn.
 */
function AgentBanner({ tab }: { tab: BrowserTab }) {
  const agent = tab.agent!
  const key = agentKey(agent.hostKey, agent.sessionId)
  const paused = useBrowser((s) => Boolean(s.paused[key]))
  const session = useHostStore((s) => s.runtimes[agent.hostKey]?.replica.sessions[agent.sessionId])
  const working = session?.status === 'running'
  const title = session?.title || agent.sessionTitle
  return (
    <div
      className={`banner agent-banner ${paused ? 'paused' : working ? 'working' : ''}`}
      role="status"
    >
      <Bot size={15} />
      <span className="agent-banner-text">
        {paused ? (
          <>You have control of this tab</>
        ) : (
          <>
            <strong>{agent.label}</strong>{' '}
            {working ? 'is using this tab' : 'has been using this tab'}
          </>
        )}
        {title && <span className="muted"> · {title}</span>}
      </span>
      {paused ? (
        <button onClick={() => resumeAgent(agent.hostKey, agent.sessionId)}>
          <Play size={13} /> Let {agent.label} continue
        </button>
      ) : (
        <>
          <button onClick={() => pauseAgent(agent.hostKey, agent.sessionId)}>
            <Hand size={13} /> Take over
          </button>
          {working && (
            <button
              onClick={() => {
                pauseAgent(agent.hostKey, agent.sessionId)
                void interrupt(agent.sessionId).catch(() => {})
              }}
            >
              <Square size={12} /> Stop
            </button>
          )}
        </>
      )}
    </div>
  )
}

function TabIcon({ tab, page }: { tab: BrowserTab; page?: Page }) {
  if (page?.loading) return <span className="tab-spinner" aria-hidden />
  if (page?.crashed) return <Bug size={14} className="danger" />
  if (tab.favicon)
    return <img className="tab-favicon" src={tab.favicon} alt="" width={14} height={14} />
  return <Globe size={14} />
}

/**
 * The desktop app's native page for the active tab, laid over this frame. What the frame itself
 * shows is only seen while the page is hidden: a still picture under app menus, or why the page
 * cannot be shown (crashed, failed to load).
 */
function NativePage({ tab, page, onRetry }: { tab?: BrowserTab; page: Page; onRetry(): void }) {
  const host = useRef<HTMLDivElement>(null)
  const problem = Boolean(page.crashed || page.error)
  const snapshot = useNativeLayout(host, tab?.id ?? null, Boolean(tab) && !problem)
  if (!tab) return null
  return (
    <div className={`page-frame native-frame ${tab.agent ? 'agent-driven' : ''}`} ref={host}>
      {snapshot && !problem && <img className="page-snapshot" src={snapshot} alt="" />}
      {page.crashed && (
        <div className="page-problem" role="alert">
          <Bug size={24} />
          <h3>This page crashed</h3>
          <p className="muted small">Reason: {page.crashed}</p>
          <button className="primary-btn" onClick={onRetry}>
            Reload
          </button>
        </div>
      )}
      {!page.crashed && page.error && (
        <div className="page-problem" role="alert">
          <Globe size={24} />
          <h3>Could not open this page</h3>
          <p className="muted small">
            {page.error.description} ({page.error.code})
            <br />
            {page.error.url}
          </p>
          {tab.via && (
            <p className="muted small">
              Is something listening on port {tab.via.port} on {tab.via.host}?
            </p>
          )}
          <button className="primary-btn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}

function PageMenu({
  tab,
  page,
  blank,
  canAttach,
  onFind,
  onScreenshot,
}: {
  tab: BrowserTab
  page: Page
  blank: boolean
  canAttach: boolean
  onFind(): void
  onScreenshot(): void
}) {
  const run = (close: () => void, fn: () => unknown) => () => {
    close()
    void fn()
  }
  const zoom = Math.round((page.zoom ?? 1) * 100)
  return (
    <Dropdown
      placement="bottom"
      align="end"
      trigger={({ toggle, open }) => (
        <button
          type="button"
          className={`icon-btn ${open ? 'active' : ''}`}
          aria-label="Page menu"
          onClick={toggle}
        >
          <MoreHorizontal size={17} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-zoom">
            <span className="menu-title">Zoom</span>
            <span className="spacer" />
            <button
              className="icon-btn"
              aria-label="Zoom out"
              disabled={blank}
              onClick={() => void browserCommand({ op: 'zoom', tabId: tab.id, direction: -1 })}
            >
              <ZoomOut size={15} />
            </button>
            <button
              className="zoom-value"
              disabled={blank}
              onClick={() => void browserCommand({ op: 'zoom', tabId: tab.id, direction: 0 })}
            >
              {zoom}%
            </button>
            <button
              className="icon-btn"
              aria-label="Zoom in"
              disabled={blank}
              onClick={() => void browserCommand({ op: 'zoom', tabId: tab.id, direction: 1 })}
            >
              <ZoomIn size={15} />
            </button>
          </div>
          <div className="menu-sep" />
          <MenuRow
            icon={<Search size={16} />}
            title="Find in page"
            disabled={blank}
            onClick={run(close, onFind)}
          />
          <MenuRow
            icon={<Camera size={16} />}
            title="Attach screenshot to message"
            disabled={blank || !canAttach}
            onClick={run(close, onScreenshot)}
          />
          <MenuRow
            icon={<FileText size={16} />}
            title="Save as PDF"
            disabled={blank}
            onClick={run(close, () => browserCommand({ op: 'pdf', tabId: tab.id }))}
          />
          <MenuRow
            icon={<Bug size={16} />}
            title="Developer tools"
            disabled={blank}
            onClick={run(close, () => browserCommand({ op: 'devtools', tabId: tab.id }))}
          />
          <MenuRow
            icon={<RotateCw size={16} />}
            title="Hard reload"
            disabled={blank}
            onClick={run(close, () => browserCommand({ op: 'hard-reload', tabId: tab.id }))}
          />
          <MenuRow
            icon={<ExternalLink size={16} />}
            title="Open in your browser"
            disabled={blank || Boolean(tab.via)}
            onClick={run(close, () => browserCommand({ op: 'open-external', url: tab.url }))}
          />
          <div className="menu-sep" />
          <MenuRow
            icon={<Trash2 size={16} />}
            title="Clear browsing data"
            onClick={run(close, () => browserCommand({ op: 'clear-data' }))}
          />
        </>
      )}
    </Dropdown>
  )
}

function MenuRow({
  icon,
  title,
  disabled,
  onClick,
}: {
  icon: React.ReactNode
  title: string
  disabled?: boolean
  onClick(): void
}) {
  return (
    <button className="menu-row" disabled={disabled} onClick={onClick}>
      {icon}
      <span className="menu-text">
        <span className="menu-title">{title}</span>
      </span>
    </button>
  )
}

function FindBar({
  tabId,
  found,
  focusKey,
  onClose,
}: {
  tabId: number
  focusKey: number
  found?: Page['found']
  onClose(): void
}) {
  const [text, setText] = useState('')
  const input = useRef<HTMLInputElement>(null)
  // Focused when opened, and again on each Ctrl+F while open.
  useEffect(() => {
    input.current?.focus()
    input.current?.select()
  }, [focusKey])
  useEffect(() => () => void browserCommand({ op: 'stop-find', tabId }), [tabId])
  const find = (forward: boolean, next: boolean) =>
    void browserCommand({ op: 'find', tabId, text, forward, next })
  return (
    <form className="find-bar" role="search" onSubmit={(e: FormEvent) => e.preventDefault()}>
      <Search size={14} />
      <input
        ref={input}
        aria-label="Find in page"
        placeholder="Find in page"
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          void browserCommand({ op: 'find', tabId, text: e.target.value })
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            if (text) find(!e.shiftKey, true)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            onClose()
          }
        }}
      />
      <span className="muted small find-count">
        {text && found ? `${found.matches ? found.active : 0}/${found.matches}` : ''}
      </span>
      <button
        type="button"
        className="icon-btn"
        aria-label="Previous match"
        disabled={!text}
        onClick={() => find(false, true)}
      >
        <ChevronUp size={15} />
      </button>
      <button
        type="button"
        className="icon-btn"
        aria-label="Next match"
        disabled={!text}
        onClick={() => find(true, true)}
      >
        <ChevronDown size={15} />
      </button>
      <button type="button" className="icon-btn" aria-label="Close find" onClick={onClose}>
        <X size={15} />
      </button>
    </form>
  )
}

function PromptBanner({ prompt }: { prompt: BrowserPrompt }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  if (prompt.type === 'permission') {
    const answer = (allow: boolean) =>
      void browserCommand({ op: 'permission', id: prompt.id, allow })
    return (
      <div className="banner prompt" role="alertdialog" aria-label="Permission request">
        <span className="prompt-text">
          <strong>{prompt.origin.replace(/^https?:\/\//, '')}</strong> wants to{' '}
          {permissionText(prompt)}
        </span>
        <span className="spacer" />
        <button className="ghost-btn" onClick={() => answer(false)}>
          Block
        </button>
        <button className="primary-btn" onClick={() => answer(true)}>
          Allow
        </button>
      </div>
    )
  }
  return (
    <form
      className="banner prompt login"
      aria-label="Sign in"
      onSubmit={(e) => {
        e.preventDefault()
        void browserCommand({ op: 'login', id: prompt.id, username, password })
      }}
    >
      <span className="prompt-text">
        {prompt.proxy ? 'The proxy' : <strong>{prompt.host}</strong>} asks you to sign in
        {prompt.realm ? ` (${prompt.realm})` : ''}
      </span>
      <input
        aria-label="Username"
        placeholder="Username"
        autoComplete="username"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
      />
      <input
        aria-label="Password"
        placeholder="Password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button
        type="button"
        className="ghost-btn"
        onClick={() => void browserCommand({ op: 'login', id: prompt.id })}
      >
        Cancel
      </button>
      <button type="submit" className="primary-btn">
        Sign in
      </button>
    </form>
  )
}

type ConsoleFilter = 'all' | 'error' | 'warning' | 'info'

const FILTERS: { id: ConsoleFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'error', label: 'Errors' },
  { id: 'warning', label: 'Warnings' },
  { id: 'info', label: 'Info' },
]

const matches = (filter: ConsoleFilter, level: BrowserConsoleEntry['level']) =>
  filter === 'all' || (filter === 'info' ? level === 'info' || level === 'debug' : level === filter)

const clock = (time: number) =>
  new Date(time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })

function ConsoleDrawer({
  tabId,
  errors,
  url,
  onAttach,
  onClose,
}: {
  tabId: number
  errors: number
  url: string
  onAttach?: (text: string) => void
  onClose(): void
}) {
  const [entries, setEntries] = useState<BrowserConsoleEntry[]>([])
  const [filter, setFilter] = useState<ConsoleFilter>('all')
  const [copied, setCopied] = useState(false)
  const list = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    const refresh = () =>
      void browserCommand<BrowserConsoleEntry[]>({ op: 'console', tabId }).then((e) => {
        if (alive && e) setEntries(e)
      })
    refresh()
    const timer = setInterval(refresh, 1500)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [tabId, errors, url])
  const shown = entries.filter((e) => matches(filter, e.level))
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight })
  }, [shown.length])
  const count = (f: ConsoleFilter) => entries.filter((e) => matches(f, e.level)).length
  const asText = () =>
    [`Console of ${url}`, '']
      .concat(
        shown.map(
          (e) =>
            `[${e.level}] ${e.message}${e.source ? ` (${e.source}${e.line ? `:${e.line}` : ''})` : ''}`,
        ),
      )
      .join('\n')
  const copy = () => {
    void navigator.clipboard?.writeText(asText()).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    })
  }
  return (
    <div className="console-drawer" aria-label="Console">
      <div className="console-head">
        <div className="console-filters" role="tablist" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              role="tab"
              aria-selected={filter === f.id}
              className={`console-filter ${filter === f.id ? 'on' : ''} ${f.id}`}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
              {f.id !== 'all' && count(f.id) > 0 && (
                <span className="console-count">{count(f.id)}</span>
              )}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {onAttach && (
          <button
            className="ghost-btn small"
            disabled={!shown.length}
            onClick={() => onAttach(asText())}
          >
            Attach to message
          </button>
        )}
        <button
          className="icon-btn"
          aria-label="Copy"
          title="Copy"
          disabled={!shown.length}
          onClick={copy}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
        <button
          className="icon-btn"
          aria-label="Clear console"
          title="Clear"
          onClick={() => {
            void browserCommand({ op: 'clear-console', tabId })
            setEntries([])
          }}
        >
          <Trash2 size={14} />
        </button>
        <button className="icon-btn" aria-label="Close console" title="Close" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="console-list" ref={list}>
        {shown.length === 0 && (
          <div className="console-empty">
            <Terminal size={16} />
            {entries.length === 0 ? 'Nothing logged yet' : 'Nothing matches this filter'}
          </div>
        )}
        {shown.map((e, i) => (
          <div key={i} className={`console-row ${e.level}`}>
            <span className="console-level" aria-label={e.level}>
              {e.level === 'error' ? (
                <CircleAlert size={13} />
              ) : e.level === 'warning' ? (
                <TriangleAlert size={13} />
              ) : (
                <Info size={13} />
              )}
            </span>
            <span className="console-msg">{e.message}</span>
            <span className="console-meta">
              {e.source && (
                <span className="console-src" title={e.source}>
                  {e.source.split('/').pop()}
                  {e.line ? `:${e.line}` : ''}
                </span>
              )}
              <span className="console-time">{clock(e.time)}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

function Downloads() {
  const { downloads, dismissDownload } = useBrowser()
  if (!downloads.length) return null
  return (
    <div className="downloads" aria-label="Downloads">
      {downloads.map((d) => (
        <div key={d.id} className={`download ${d.state}`}>
          <Download size={14} />
          <span className="download-name" title={d.filename}>
            {d.filename}
          </span>
          <span className="muted small">
            {d.state === 'progressing'
              ? d.total
                ? `${Math.round((d.received / d.total) * 100)}%`
                : `${Math.round(d.received / 1024)} KB`
              : d.state === 'completed'
                ? 'Done'
                : d.state === 'cancelled'
                  ? 'Cancelled'
                  : 'Failed'}
          </span>
          {d.state === 'completed' && (
            <button
              className="ghost-btn small"
              onClick={() => void browserCommand({ op: 'reveal-download', id: d.id })}
            >
              Show in folder
            </button>
          )}
          <button
            className="icon-btn"
            aria-label={`Dismiss ${d.filename}`}
            onClick={() => dismissDownload(d.id)}
          >
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  )
}
