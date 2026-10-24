import type { NativeImage, WebContents } from 'electron'
import type { BrowserAgentAction, BrowserUseResult } from '@beddcode/contracts'
import { isLoopbackUrl, navigationAllowed, type ConsoleLog } from './browserGuard.ts'
import { cap, evaluateSource, parseKey } from './browserAgentKeys.ts'
import { AGENT_WORLD, inPage } from './browserAgentScript.ts'

// Browser use, the part that touches the page: runs an agent's browser_* tool on one tab's
// WebContents. Reading the page happens in an isolated world (browserAgentScript.ts); clicks, keys
// and typing go through the Chrome DevTools Protocol, so the page sees real, trusted input. The
// tab is chosen, and the user asked, by the app page (apps/web/src/features/browser/browserAgent.ts).

/** What browserAgent needs of a tab. */
export interface AgentPage {
  tabId: number
  contents: WebContents
  console: ConsoleLog
  /** Loads an address the way the pane does (only web pages). */
  load(url: string): void
}

const SNAPSHOT_CHARS = 40_000
const EVALUATE_CHARS = 20_000
const LOAD_TIMEOUT_MS = 20_000
const CAPTURE_TIMEOUT_MS = 4000
/** Debugger sessions are dropped after this long without an action (the hang monitor needs it). */
const DETACH_IDLE_MS = 30_000

type Image = { data: string; mime: 'image/png' | 'image/jpeg' }

class Failure extends Error {}

/** How long after sending input its echo (an input event) may still arrive. */
const INPUT_ECHO_MS = 400

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Failure(`${what} took too long.`)), ms)
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    )
  })
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

export class BrowserAgent {
  private sessions = new Map<WebContents, { idle: NodeJS.Timeout; dialogs: string[] }>()
  /** Until when input arriving at a page is the agent's own (sent just now through CDP). */
  private injecting = new Map<WebContents, number>()

  /**
   * The agent has just sent input to this page, so input seen now is its own and not the user
   * taking over. Only the moments around its clicks and keys count: the user's input while the
   * agent waits or reads the page still pauses it.
   */
  busy(contents: WebContents): boolean {
    return (this.injecting.get(contents) ?? 0) > Date.now()
  }

  async run(page: AgentPage, action: BrowserAgentAction): Promise<BrowserUseResult> {
    const contents = page.contents
    if (contents.isDestroyed()) return { ok: false, error: 'The tab was closed.' }
    if (contents.isCrashed())
      return { ok: false, error: 'The page crashed. Use browser_reload to load it again.' }
    try {
      return await this.dispatch(page, action)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { ok: false, error: message }
    }
  }

  private async dispatch(page: AgentPage, action: BrowserAgentAction): Promise<BrowserUseResult> {
    const { contents } = page
    const a = action.args
    const ref = str(a.ref)
    switch (action.tool) {
      case 'browser_navigate': {
        const url = str(a.url)
        if (!url || !navigationAllowed(url))
          throw new Failure('Only http:// and https:// addresses can be opened.')
        return this.acting(page, 'navigate', async () => {
          page.load(url)
          return `Opened ${url}.`
        })
      }
      case 'browser_back':
        if (!contents.navigationHistory.canGoBack())
          throw new Failure('There is no page to go back to.')
        return this.acting(page, 'navigate', async () => {
          contents.navigationHistory.goBack()
          return 'Went back.'
        })
      case 'browser_forward':
        if (!contents.navigationHistory.canGoForward())
          throw new Failure('There is no page to go forward to.')
        return this.acting(page, 'navigate', async () => {
          contents.navigationHistory.goForward()
          return 'Went forward.'
        })
      case 'browser_reload':
        return this.acting(page, 'navigate', async () => {
          contents.reload()
          return 'Reloaded.'
        })
      case 'browser_snapshot': {
        await this.waitLoaded(contents)
        const tree = await this.inPage<string>(contents, `bc.snapshot(${SNAPSHOT_CHARS})`)
        return {
          ok: true,
          text: `${this.where(contents)}\n\n${tree || '(the page is empty)'}`,
        }
      }
      case 'browser_click': {
        if (!ref) throw new Failure('Give the ref of the element to click (from browser_snapshot).')
        const ask = await this.askBeforeSubmit(page, action, ref, 'click')
        if (ask) return ask
        return this.acting(page, 'act', async () => {
          const p = await this.point(contents, ref)
          const button = a.button === 'right' || a.button === 'middle' ? a.button : 'left'
          await this.click(contents, p.x, p.y, button, a.double === true ? 2 : 1)
          return `${a.double === true ? 'Double-clicked' : 'Clicked'} ${p.what}.`
        })
      }
      case 'browser_hover': {
        if (!ref) throw new Failure('Give the ref of the element to hover (from browser_snapshot).')
        return this.acting(page, 'act', async () => {
          const p = await this.point(contents, ref)
          await this.cdp(contents, 'Input.dispatchMouseEvent', {
            type: 'mouseMoved',
            x: p.x,
            y: p.y,
          })
          return `Hovered over ${p.what}.`
        })
      }
      case 'browser_type': {
        if (!ref)
          throw new Failure('Give the ref of the field to type into (from browser_snapshot).')
        const text = typeof a.text === 'string' ? a.text : ''
        const submit = a.submit === true
        if (submit) {
          const ask = await this.askBeforeSubmit(page, action, ref, 'enter')
          if (ask) return ask
        }
        return this.acting(page, 'act', async () => {
          const clear = a.clear !== false
          const f = await this.inPage<{ focused: boolean; what: string; hasValue: boolean }>(
            contents,
            `bc.focus(${JSON.stringify(ref)}, ${clear})`,
          )
          if (!f.focused) {
            // Some fields only take focus from a real click.
            const p = await this.point(contents, ref)
            await this.click(contents, p.x, p.y, 'left', 1)
            if (clear) await this.inPage(contents, `bc.focus(${JSON.stringify(ref)}, true)`)
          }
          if (clear && f.hasValue && text === '') await this.key(contents, 'Delete')
          if (text) await this.cdp(contents, 'Input.insertText', { text })
          if (submit) await this.key(contents, 'Enter')
          const value = submit
            ? undefined
            : await this.inPage<string>(contents, `bc.value(${JSON.stringify(ref)})`).catch(
                () => undefined,
              )
          return `Typed into ${f.what}${value !== undefined ? ` (its value is now ${JSON.stringify(value)})` : ''}${submit ? ' and pressed Enter' : ''}.`
        })
      }
      case 'browser_press_key': {
        const spec = str(a.key)
        const parsed = spec ? parseKey(spec) : null
        if (!spec || !parsed)
          throw new Failure(
            `Unknown key ${JSON.stringify(spec ?? '')}. Use names like Enter, Tab, Escape, ArrowDown, Backspace, a, Control+a, Shift+Tab.`,
          )
        if (parsed.key === 'Enter' && parsed.modifiers === 0) {
          const ask = await this.askBeforeSubmit(page, action, ref, 'enter')
          if (ask) return ask
        }
        return this.acting(page, 'act', async () => {
          if (ref) await this.inPage(contents, `bc.el(${JSON.stringify(ref)}).focus()`)
          await this.key(contents, spec)
          return `Pressed ${spec}.`
        })
      }
      case 'browser_select_option': {
        if (!ref) throw new Failure('Give the ref of the select box (from browser_snapshot).')
        const raw = Array.isArray(a.values) ? a.values : a.value !== undefined ? [a.value] : []
        const values = raw.filter((v) => typeof v === 'string' || typeof v === 'number').map(String)
        if (!values.length) throw new Failure('Give the option to pick, by its label or value.')
        return this.acting(page, 'act', async () => {
          const r = await this.inPage<{ what: string; selected: string[] }>(
            contents,
            `bc.select(${JSON.stringify(ref)}, ${JSON.stringify(values)})`,
          )
          return `Picked ${r.selected.map((s) => JSON.stringify(s)).join(', ')} in ${r.what}.`
        })
      }
      case 'browser_scroll': {
        const direction = str(a.direction)
        const amount = Math.min(Math.max(num(a.amount) ?? 600, 1), 20_000)
        let dx = 0
        let dy = 0
        if (direction === 'down') dy = amount
        else if (direction === 'up') dy = -amount
        else if (direction === 'right') dx = amount
        else if (direction === 'left') dx = -amount
        else if (direction !== undefined)
          throw new Failure('direction is one of up, down, left, right.')
        if (!ref && !dx && !dy)
          throw new Failure('Give a direction, or the ref of an element to bring into view.')
        return this.acting(page, 'act', () =>
          this.inPage<string>(
            contents,
            `bc.scrollBy(${JSON.stringify(ref ?? null)}, ${dx}, ${dy})`,
          ),
        )
      }
      case 'browser_wait_for':
        return this.waitFor(page, a)
      case 'browser_screenshot': {
        await this.waitLoaded(contents)
        const image = await this.capture(contents)
        if (!image) throw new Failure('The page could not be captured (it may still be loading).')
        const size = image.getSize()
        const scaled = size.width > 1280 ? image.resize({ width: 1280, quality: 'good' }) : image
        const shot: Image = { data: scaled.toJPEG(80).toString('base64'), mime: 'image/jpeg' }
        const s = scaled.getSize()
        return {
          ok: true,
          text: `Screenshot of the visible part of the page (${s.width}×${s.height}).\n${this.where(contents)}`,
          image: shot,
        }
      }
      case 'browser_console': {
        const level = str(a.level) ?? 'all'
        const limit = Math.min(Math.max(num(a.limit) ?? 50, 1), 200)
        const entries = page.console
          .list()
          .filter((e) =>
            level === 'error'
              ? e.level === 'error'
              : level === 'warning'
                ? e.level === 'error' || e.level === 'warning'
                : true,
          )
          .slice(-limit)
        if (a.clear === true) page.console.clear()
        if (!entries.length)
          return {
            ok: true,
            text: `No ${level === 'all' ? '' : `${level} `}console messages since the page loaded.\n${this.where(contents)}`,
          }
        const lines = entries.map((e) => {
          const at = e.source
            ? ` (${e.source.replace(/^https?:\/\/[^/]+/, '')}${e.line ? `:${e.line}` : ''})`
            : ''
          return `[${e.level}] ${e.message}${at}`
        })
        return {
          ok: true,
          text: cap(
            `${entries.length} console message${entries.length === 1 ? '' : 's'}:\n${lines.join('\n')}`,
            30_000,
          ),
        }
      }
      case 'browser_evaluate': {
        const script = str(a.script) ?? str(a.expression) ?? str(a.function)
        if (!script) throw new Failure('Give the JavaScript to run.')
        return this.acting(page, 'act', async () => {
          let out: string
          try {
            out = String(
              await withTimeout(
                contents.executeJavaScript(evaluateSource(script), true),
                30_000,
                'The script',
              ),
            )
          } catch (err) {
            throw new Failure(
              `The script failed: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          return `Result:\n${cap(out, EVALUATE_CHARS)}`
        })
      }
      case 'browser_tabs':
        // Tabs are the app page's business; it answers this one itself.
        throw new Failure('browser_tabs is handled by the app.')
    }
    throw new Failure(`Unknown browser tool ${action.tool}.`)
  }

  /** The page's title and address, the last line of most answers. */
  private where(contents: WebContents): string {
    if (contents.isDestroyed()) return ''
    const title = contents.getTitle()
    const url = contents.getURL()
    return `Page: ${title && title !== url ? `${title} — ` : ''}${url}`
  }

  /**
   * Runs an action that may change the page, waits for what it started (a navigation, a
   * render), and answers with what happened, any dialog, and a small picture for the user.
   */
  private async acting(
    page: AgentPage,
    kind: 'act' | 'navigate',
    act: () => Promise<string>,
  ): Promise<BrowserUseResult> {
    const { contents } = page
    const before = contents.getURL()
    let navigated = false
    const onNav = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
      if (details.isMainFrame && !details.isSameDocument) navigated = true
    }
    contents.on('did-start-navigation', onNav)
    const session = await this.attach(contents)
    session.dialogs.length = 0
    let said: string
    try {
      said = await act()
      await sleep(kind === 'navigate' ? 250 : 150)
      if (navigated || kind === 'navigate' || contents.isLoading()) await this.waitLoaded(contents)
      else await sleep(150)
    } finally {
      contents.removeListener('did-start-navigation', onNav)
    }
    const lines = [said]
    for (const d of session.dialogs) lines.push(d)
    const after = contents.getURL()
    if (kind === 'act' && after !== before) lines.push(`The page is now ${after}.`)
    const failed = this.loadError
    if (failed.has(contents)) {
      lines.push(`Loading failed: ${failed.get(contents)}.`)
      failed.delete(contents)
    }
    lines.push(this.where(contents))
    const thumb = await this.thumb(contents)
    return { ok: true, text: lines.join('\n'), ...(thumb ? { thumb } : {}) }
  }

  private loadError = new WeakMap<WebContents, string>()

  /** Waits (a while) for the page to finish loading. */
  private async waitLoaded(contents: WebContents) {
    if (!contents.isLoading()) return
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer)
        contents.removeListener('did-stop-loading', done)
        contents.removeListener('did-fail-load', fail)
        resolve()
      }
      const fail = (
        _e: unknown,
        code: number,
        description: string,
        url: string,
        isMainFrame: boolean,
      ) => {
        if (isMainFrame && code !== -3) this.loadError.set(contents, `${description} (${url})`)
      }
      const timer = setTimeout(done, LOAD_TIMEOUT_MS)
      contents.on('did-stop-loading', done)
      contents.on('did-fail-load', fail)
    })
  }

  private async askBeforeSubmit(
    page: AgentPage,
    action: BrowserAgentAction,
    ref: string | undefined,
    how: 'click' | 'enter',
  ): Promise<BrowserUseResult | null> {
    if (!action.confirmSubmits || action.approved) return null
    const url = page.contents.getURL()
    if (isLoopbackUrl(url)) return null
    const info = await this.inPage<{ what: string; submits: boolean; form: string }>(
      page.contents,
      `bc.info(${JSON.stringify(ref ?? null)}, ${JSON.stringify(how)})`,
    )
    if (!info.submits) return null
    let host = url
    try {
      host = new URL(url).host
    } catch {
      // Keep the address.
    }
    return {
      ok: false,
      needsApproval: {
        title: `Let ${action.agent} send a form on ${host}?`,
        detail: `${how === 'click' ? 'Clicking' : 'Pressing Enter in'} ${info.what} on ${url}`,
      },
    }
  }

  private async waitFor(page: AgentPage, a: Record<string, unknown>): Promise<BrowserUseResult> {
    const { contents } = page
    const seconds = num(a.timeout_seconds) ?? num(a.timeout_s)
    const timeout = Math.min(Math.max(seconds ?? 10, 0.1), 30) * 1000
    const cond = {
      text: str(a.text),
      textGone: str(a.text_gone),
      selector: str(a.selector),
    }
    const url = str(a.url)
    if (!cond.text && !cond.textGone && !cond.selector && !url) {
      // Nothing to watch for: just a pause.
      if (seconds === undefined)
        throw new Failure(
          'Say what to wait for: text, text_gone, selector, url, or timeout_seconds.',
        )
      await sleep(timeout)
      return { ok: true, text: `Waited ${timeout / 1000}s.\n${this.where(contents)}` }
    }
    const end = Date.now() + timeout
    const expr = `bc.check(${JSON.stringify(cond)})`
    for (;;) {
      if (contents.isDestroyed()) throw new Failure('The tab was closed.')
      const urlOk = !url || contents.getURL().includes(url)
      let ok = false
      if (urlOk && !contents.isLoading()) {
        try {
          ok = await this.inPage<boolean>(contents, expr)
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Bad selector')) throw err
        }
      }
      if (ok) {
        const what = [
          cond.text && `text ${JSON.stringify(cond.text)} appeared`,
          cond.textGone && `text ${JSON.stringify(cond.textGone)} is gone`,
          cond.selector && `${cond.selector} is shown`,
          url && `the address has ${url}`,
        ]
          .filter(Boolean)
          .join(', ')
        const thumb = await this.thumb(contents)
        return {
          ok: true,
          text: `Done waiting: ${what}.\n${this.where(contents)}`,
          ...(thumb ? { thumb } : {}),
        }
      }
      if (Date.now() > end)
        throw new Failure(
          `Timed out after ${timeout / 1000}s waiting for ${JSON.stringify({ ...cond, url })}. ${this.where(contents)}`,
        )
      await sleep(200)
    }
  }

  private async inPage<T>(contents: WebContents, expression: string): Promise<T> {
    const out = (await withTimeout(
      contents.executeJavaScriptInIsolatedWorld(AGENT_WORLD, [{ code: inPage(expression) }], false),
      15_000,
      'Reading the page',
    )) as { v?: T; e?: string } | undefined
    if (!out) throw new Failure('The page did not answer (it may be loading).')
    if (out.e !== undefined) throw new Failure(out.e)
    return out.v as T
  }

  private async point(contents: WebContents, ref: string) {
    const p = await this.inPage<{ x: number; y: number; covered: string; what: string }>(
      contents,
      `bc.point(${JSON.stringify(ref)})`,
    )
    if (p.covered)
      throw new Failure(
        `${p.what} is covered by ${p.covered}. Close or scroll past it first, then take a new snapshot.`,
      )
    // Let a scroll into view settle.
    await sleep(50)
    return p
  }

  private async click(
    contents: WebContents,
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle',
    count: number,
  ) {
    await this.cdp(contents, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    for (let i = 1; i <= count; i++) {
      await this.cdp(contents, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button,
        buttons: button === 'left' ? 1 : button === 'right' ? 2 : 4,
        clickCount: i,
      })
      await this.cdp(contents, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button,
        buttons: 0,
        clickCount: i,
      })
    }
  }

  private async key(contents: WebContents, spec: string) {
    const k = parseKey(spec)
    if (!k) throw new Failure(`Unknown key ${spec}.`)
    const base = {
      key: k.key,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
      modifiers: k.modifiers,
    }
    await this.cdp(contents, 'Input.dispatchKeyEvent', {
      type: k.text ? 'keyDown' : 'rawKeyDown',
      ...base,
      ...(k.text ? { text: k.text, unmodifiedText: k.text } : {}),
    })
    await this.cdp(contents, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  private async capture(contents: WebContents): Promise<NativeImage | null> {
    try {
      const image = await withTimeout(contents.capturePage(), CAPTURE_TIMEOUT_MS, 'Capturing')
      return image.isEmpty() ? null : image
    } catch {
      return null
    }
  }

  private async thumb(contents: WebContents): Promise<Image | undefined> {
    const image = await this.capture(contents)
    if (!image) return undefined
    const small =
      image.getSize().width > 640 ? image.resize({ width: 640, quality: 'good' }) : image
    return { data: small.toJPEG(65).toString('base64'), mime: 'image/jpeg' }
  }

  private async attach(contents: WebContents) {
    let session = this.sessions.get(contents)
    if (!session) {
      const dbg = contents.debugger
      if (!dbg.isAttached()) dbg.attach('1.3')
      const s = { idle: setTimeout(() => {}, 0), dialogs: [] as string[] }
      session = s
      this.sessions.set(contents, s)
      dbg.on('message', (_e, method, params) => {
        if (method !== 'Page.javascriptDialogOpening') return
        const p = params as { type: string; message: string; defaultPrompt?: string }
        // Alerts are acknowledged; confirm, prompt and "leave page?" are declined.
        const accept = p.type === 'alert'
        s.dialogs.push(
          `The page showed a ${p.type} dialog: ${JSON.stringify(p.message.slice(0, 500))} (${accept ? 'dismissed with OK' : 'answered Cancel'}).`,
        )
        void dbg.sendCommand('Page.handleJavaScriptDialog', { accept }).catch(() => {})
      })
      dbg.on('detach', () => {
        clearTimeout(s.idle)
        this.sessions.delete(contents)
      })
      contents.once('destroyed', () => {
        clearTimeout(s.idle)
        this.sessions.delete(contents)
      })
      await dbg.sendCommand('Page.enable').catch(() => {})
    }
    clearTimeout(session.idle)
    session.idle = setTimeout(() => this.detach(contents), DETACH_IDLE_MS)
    session.idle.unref()
    return session
  }

  /** Lets go of the page's debugger session (when the agent is done with the tab). */
  detach(contents: WebContents) {
    this.injecting.delete(contents)
    const session = this.sessions.get(contents)
    if (!session) return
    clearTimeout(session.idle)
    this.sessions.delete(contents)
    try {
      if (!contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach()
    } catch {
      // Already gone.
    }
  }

  private async cdp(contents: WebContents, method: string, params: Record<string, unknown>) {
    await this.attach(contents)
    // The page reports injected input as input events a moment later; see busy().
    const input = method.startsWith('Input.')
    if (input) this.injecting.set(contents, Date.now() + INPUT_ECHO_MS)
    try {
      return await withTimeout(contents.debugger.sendCommand(method, params), 10_000, method)
    } finally {
      if (input) this.injecting.set(contents, Date.now() + INPUT_ECHO_MS)
    }
  }
}
