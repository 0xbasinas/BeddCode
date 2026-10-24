import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bug, Globe, Plus, RotateCw, X, MousePointer2 } from 'lucide-react'
import { useBrowser, type BrowserTab } from './browserStore.ts'
import '../../ui/desktop.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { attachUpload, stageAttachment } from '../composer/attachments.ts'
import { hostRequest } from '../../stores/host.ts'
import {
  CANCEL_PICK_SCRIPT,
  elementContext,
  normalizeUrl,
  pickElement,
  PICK_ELEMENT_SCRIPT,
  type PickedElement,
} from '@beddcode/client-runtime'

/** The subset of Electron's <webview> element this pane uses. */
interface WebviewElement extends HTMLElement {
  src: string
  goBack(): void
  goForward(): void
  reload(): void
  stop(): void
  openDevTools(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  executeJavaScript<T>(code: string): Promise<T>
  capturePage(rect: PickedElement['rect']): Promise<{ toDataURL(): string }>
}

/** What a page's view reports about itself. */
interface PageState {
  back: boolean
  forward: boolean
  loading: boolean
}
const IDLE: PageState = { back: false, forward: false, loading: false }

const isDesktop = () => typeof window !== 'undefined' && Boolean(window.beddcodeDesktop)

/** A small tabbed browser for previewing the app an agent is building. */
export function BrowserPane({ draftId }: { draftId?: string }) {
  const hostKey = useHostKey()
  const { tabs, active, open, close, activate } = useBrowser()
  const current = tabs.find((t) => t.id === active)
  const [address, setAddress] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [pages, setPages] = useState<Record<number, PageState>>({})
  const nav = (current && pages[current.id]) || IDLE
  // Every tab keeps its own view alive, so switching tabs does not reload the page.
  const views = useRef(new Map<number, WebviewElement>())
  const activeView = () => (current ? (views.current.get(current.id) ?? null) : null)
  const register = useCallback((id: number, el: WebviewElement | null) => {
    if (el) views.current.set(id, el)
    else views.current.delete(id)
  }, [])
  const onPage = useCallback(
    (id: number, patch: Partial<PageState>) =>
      setPages((p) => ({ ...p, [id]: { ...(p[id] ?? IDLE), ...patch } })),
    [],
  )
  const frame = useRef<HTMLIFrameElement>(null)
  const [picking, setPicking] = useState(false)
  const [pickError, setPickError] = useState<string>()
  const picker = useRef<{ cancel(): void } | null>(null)

  useEffect(() => {
    setPicking(false)
    setPickError(undefined)
    return () => {
      picker.current?.cancel()
      picker.current = null
    }
  }, [current?.id, current?.url, hostKey, draftId, reloadKey])

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
    if (!draftId) return
    setPickError(undefined)
    const webview = activeView()
    let cancelled = false
    let page: Document | undefined
    const request = {
      cancel: () => {
        cancelled = true
        if (webview) void webview.executeJavaScript(CANCEL_PICK_SCRIPT).catch(() => {})
        else page?.dispatchEvent(new Event('beddcode:cancel-element-picker'))
      },
    }
    picker.current = request
    setPicking(true)
    try {
      let element: PickedElement | null
      if (webview) {
        element = await webview.executeJavaScript<PickedElement | null>(PICK_ELEMENT_SCRIPT)
      } else {
        // The browser's same-origin policy applies to iframe previews.
        try {
          page = frame.current?.contentWindow?.document
        } catch {
          throw new Error(
            'Open this preview in the desktop app to pick elements from another origin.',
          )
        }
        if (!page) throw new Error('Wait for the preview to load, then try again.')
        element = await pickElement(page)
      }
      if (!element || cancelled) return
      void attachUpload(
        hostKey,
        draftId,
        new File([elementContext(element)], 'browser-element.txt', { type: 'text/plain' }),
      )
      if (webview && element.rect.width > 0 && element.rect.height > 0) {
        // Reserve the screenshot chip now so Send waits for both attachments.
        void stageAttachment(hostKey, draftId, 'browser-element.png', 0, async () => {
          const image = await webview.capturePage(element.rect)
          return hostRequest(hostKey, 'attachments.upload', {
            name: 'browser-element.png',
            dataBase64: image.toDataURL().split(',')[1]!,
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

  // A page that opens a new window (target=_blank) gets a tab of its own.
  useEffect(
    () => window.beddcodeDesktop?.browser?.onOpen((url) => open(url, { newTab: true })),
    [open],
  )

  // The address bar follows the active tab.
  useEffect(() => setAddress(current?.url ?? ''), [current?.id, current?.url])

  const go = (text: string, newTab = false) => {
    const url = normalizeUrl(text)
    if (url) open(url, { newTab })
  }

  const reload = () => {
    const webview = activeView()
    if (webview) webview[nav.loading ? 'stop' : 'reload']()
    else setReloadKey((k) => k + 1)
  }

  return (
    <div className="pane-body browser">
      <div className="pane-head">
        <h2>Browser</h2>
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
                {t.favicon ? (
                  <img className="tab-favicon" src={t.favicon} alt="" width={14} height={14} />
                ) : (
                  <Globe size={14} />
                )}{' '}
                {t.title || t.url}
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
          go(address)
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
          disabled={!draftId || !current || current.url === 'about:blank'}
          onClick={() => void pick()}
        >
          <MousePointer2 size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Back"
          disabled={!nav.back}
          onClick={() => activeView()?.goBack()}
        >
          <ArrowLeft size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Forward"
          disabled={!nav.forward}
          onClick={() => activeView()?.goForward()}
        >
          <ArrowRight size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label={nav.loading ? 'Stop loading' : 'Reload'}
          disabled={!current}
          onClick={reload}
        >
          {nav.loading ? <X size={16} /> : <RotateCw size={16} />}
        </button>
        {isDesktop() && (
          <button
            type="button"
            className="icon-btn"
            aria-label="Open developer tools"
            title="Developer tools"
            disabled={!current || current.url === 'about:blank'}
            onClick={() => activeView()?.openDevTools()}
          >
            <Bug size={16} />
          </button>
        )}
        <div className="url-field">
          <Globe size={15} />
          <input
            aria-label="Address"
            placeholder="Search or enter a URL"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
          />
        </div>
      </form>

      {picking && (
        <div className="banner" role="status">
          Click an element to attach it. Press Escape to cancel.
        </div>
      )}
      {pickError && (
        <div className="banner error" role="alert">
          {pickError}
        </div>
      )}

      {isDesktop() &&
        tabs
          .filter((t) => t.url !== 'about:blank')
          .map((t) => (
            <DesktopPage
              key={t.id}
              tab={t}
              active={t.id === active}
              register={register}
              onPage={onPage}
            />
          ))}
      {current && current.url !== 'about:blank' ? (
        isDesktop() ? null : (
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
        )
      ) : (
        <div className="pane-empty">
          <span className="empty-icon">
            <Globe size={26} />
          </span>
          <h3>Nothing to preview</h3>
          <button
            className="primary-btn"
            onClick={() => go(address || 'localhost:3000', tabs.length === 0)}
          >
            Open {address ? 'this URL' : 'localhost:3000'}
          </button>
          {!isDesktop() && (
            <p className="muted small">
              Some sites refuse to be shown inside another page. The desktop app opens them in an
              isolated view.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/** Electron's <webview>: an isolated page with real back/forward and a title. */
function DesktopPage({
  tab,
  active,
  register,
  onPage,
}: {
  tab: BrowserTab
  active: boolean
  register(id: number, el: WebviewElement | null): void
  onPage(id: number, patch: Partial<PageState>): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<WebviewElement | null>(null)
  const { navigated, titled, faviconed } = useBrowser.getState()
  const initialUrl = useRef(tab.url)
  const latestUrl = useRef(tab.url)
  latestUrl.current = tab.url
  const ready = useRef(false)

  useEffect(() => {
    const el = host.current
    if (!el) return
    // Created by hand: React has no typing for the element, and the source must be set once.
    const webview = createElementIn(el, initialUrl.current)
    view.current = webview
    register(tab.id, webview)
    ready.current = false
    const sync = () => {
      if (ready.current) {
        onPage(tab.id, { back: webview.canGoBack(), forward: webview.canGoForward() })
      }
    }
    const onReady = () => {
      ready.current = true
      sync()
      if (latestUrl.current !== initialUrl.current && webview.getURL() !== latestUrl.current) {
        webview.src = latestUrl.current
      }
    }
    const onNavigate = (e: Event) => {
      const url = (e as Event & { url?: string }).url
      if (url) navigated(tab.id, url)
      sync()
    }
    const onTitle = (e: Event) => titled(tab.id, (e as Event & { title?: string }).title ?? '')
    const onFavicon = (e: Event) => {
      const icon = (e as Event & { favicons?: string[] }).favicons?.[0]
      if (icon) faviconed(tab.id, icon)
    }
    const onStart = () => onPage(tab.id, { loading: true })
    const onStop = () => {
      onPage(tab.id, { loading: false })
      sync()
    }
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('dom-ready', onReady)
    webview.addEventListener('page-title-updated', onTitle)
    webview.addEventListener('page-favicon-updated', onFavicon)
    webview.addEventListener('did-start-loading', onStart)
    webview.addEventListener('did-stop-loading', onStop)
    return () => {
      ready.current = false
      view.current = null
      register(tab.id, null)
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
      webview.removeEventListener('dom-ready', onReady)
      webview.removeEventListener('page-title-updated', onTitle)
      webview.removeEventListener('page-favicon-updated', onFavicon)
      webview.removeEventListener('did-start-loading', onStart)
      webview.removeEventListener('did-stop-loading', onStop)
      webview.remove()
    }
  }, [tab.id, register, onPage, navigated, titled, faviconed])

  // Typing a new address in the bar points the same webview at it.
  useEffect(() => {
    const webview = view.current
    if (
      webview &&
      ready.current &&
      webview.getURL &&
      webview.getURL() !== tab.url &&
      tab.url !== initialUrl.current
    ) {
      webview.src = tab.url
    }
  }, [tab.url])

  return <div className="page-frame" ref={host} hidden={!active} />
}

function createElementIn(parent: HTMLElement, url: string): WebviewElement {
  const webview = document.createElement('webview') as WebviewElement
  webview.setAttribute('partition', 'persist:beddcode-browser')
  webview.setAttribute('src', url)
  webview.style.width = '100%'
  webview.style.height = '100%'
  parent.appendChild(webview)
  return webview
}
