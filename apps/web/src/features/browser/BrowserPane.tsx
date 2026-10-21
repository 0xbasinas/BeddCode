import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from 'lucide-react'
import { useBrowser, type BrowserTab } from './browserStore.ts'
import { normalizeUrl } from './url.ts'

declare global {
  interface Window {
    /** Present only inside the desktop app, where pages can be shown in an isolated webview. */
    beddcodeDesktop?: { platform: string }
  }
}

/** The subset of Electron's <webview> element this pane uses. */
interface WebviewElement extends HTMLElement {
  src: string
  goBack(): void
  goForward(): void
  reload(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
}

const isDesktop = () => typeof window !== 'undefined' && Boolean(window.beddcodeDesktop)

/** A small tabbed browser for previewing the app an agent is building. */
export function BrowserPane() {
  const { tabs, active, open, close, activate } = useBrowser()
  const current = tabs.find((t) => t.id === active)
  const [address, setAddress] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [nav, setNav] = useState({ back: false, forward: false })
  const view = useRef<WebviewElement | null>(null)

  // The address bar follows the active tab.
  useEffect(() => setAddress(current?.url ?? ''), [current?.id, current?.url])

  const go = (text: string, newTab = false) => {
    const url = normalizeUrl(text)
    if (url) open(url, { newTab })
  }

  const reload = () => {
    if (view.current) view.current.reload()
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
                <Globe size={14} /> {t.title || t.url}
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
          className="icon-btn"
          aria-label="Back"
          disabled={!nav.back}
          onClick={() => view.current?.goBack()}
        >
          <ArrowLeft size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Forward"
          disabled={!nav.forward}
          onClick={() => view.current?.goForward()}
        >
          <ArrowRight size={17} />
        </button>
        <button
          type="button"
          className="icon-btn"
          aria-label="Reload"
          disabled={!current}
          onClick={reload}
        >
          <RotateCw size={16} />
        </button>
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

      {current && current.url !== 'about:blank' ? (
        isDesktop() ? (
          <DesktopPage key={current.id} tab={current} viewRef={view} onNav={setNav} />
        ) : (
          <iframe
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
          <p>
            Open a page to see the app your agent is building, such as a dev server on{' '}
            <code>localhost:3000</code>.
          </p>
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
  viewRef,
  onNav,
}: {
  tab: BrowserTab
  viewRef: { current: WebviewElement | null }
  onNav(state: { back: boolean; forward: boolean }): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const { navigated, titled } = useBrowser.getState()
  const initialUrl = useRef(tab.url)

  useEffect(() => {
    const el = host.current
    if (!el) return
    // Created by hand: React has no typing for the element, and the source must be set once.
    const webview = createElementIn(el, initialUrl.current)
    viewRef.current = webview
    const sync = () => onNav({ back: webview.canGoBack(), forward: webview.canGoForward() })
    const onNavigate = (e: Event) => {
      const url = (e as Event & { url?: string }).url
      if (url) navigated(tab.id, url)
      sync()
    }
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('page-title-updated', (e) =>
      titled(tab.id, (e as Event & { title?: string }).title ?? ''),
    )
    return () => {
      viewRef.current = null
      webview.remove()
    }
  }, [tab.id, viewRef, onNav, navigated, titled])

  // Typing a new address in the bar points the same webview at it.
  useEffect(() => {
    const webview = viewRef.current
    if (
      webview &&
      webview.getURL &&
      webview.getURL() !== tab.url &&
      tab.url !== initialUrl.current
    ) {
      webview.src = tab.url
    }
  }, [tab.url, viewRef])

  return <div className="page-frame" ref={host} />
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
