import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X, MousePointer2 } from 'lucide-react'
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
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
  executeJavaScript<T>(code: string): Promise<T>
  capturePage(rect: PickedElement['rect']): Promise<{ toDataURL(): string }>
}

const isDesktop = () => typeof window !== 'undefined' && Boolean(window.beddcodeDesktop)

/** A small tabbed browser for previewing the app an agent is building. */
export function BrowserPane({ draftId }: { draftId?: string }) {
  const hostKey = useHostKey()
  const { tabs, active, open, close, activate } = useBrowser()
  const current = tabs.find((t) => t.id === active)
  const [address, setAddress] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [nav, setNav] = useState({ back: false, forward: false })
  const view = useRef<WebviewElement | null>(null)
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
    const webview = view.current
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

      {current && current.url !== 'about:blank' ? (
        isDesktop() ? (
          <DesktopPage key={current.id} tab={current} viewRef={view} onNav={setNav} />
        ) : (
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
  const latestUrl = useRef(tab.url)
  latestUrl.current = tab.url
  const ready = useRef(false)

  useEffect(() => {
    const el = host.current
    if (!el) return
    // Created by hand: React has no typing for the element, and the source must be set once.
    const webview = createElementIn(el, initialUrl.current)
    viewRef.current = webview
    ready.current = false
    const sync = () => {
      if (ready.current) onNav({ back: webview.canGoBack(), forward: webview.canGoForward() })
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
    webview.addEventListener('did-navigate', onNavigate)
    webview.addEventListener('did-navigate-in-page', onNavigate)
    webview.addEventListener('dom-ready', onReady)
    const onTitle = (e: Event) => titled(tab.id, (e as Event & { title?: string }).title ?? '')
    webview.addEventListener('page-title-updated', onTitle)
    return () => {
      ready.current = false
      viewRef.current = null
      webview.removeEventListener('did-navigate', onNavigate)
      webview.removeEventListener('did-navigate-in-page', onNavigate)
      webview.removeEventListener('dom-ready', onReady)
      webview.removeEventListener('page-title-updated', onTitle)
      webview.remove()
    }
  }, [tab.id, viewRef, onNav, navigated, titled])

  // Typing a new address in the bar points the same webview at it.
  useEffect(() => {
    const webview = viewRef.current
    if (
      webview &&
      ready.current &&
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
