import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  session as electronSession,
  shell,
  WebContentsView,
  type Session,
  type WebContents,
} from 'electron'
import type {
  BrowserCommand,
  BrowserEvent,
  BrowserPageState,
  BrowserRect,
} from '@beddcode/contracts'
import {
  BROWSER_PARTITION,
  ConsoleLog,
  isLoopbackUrl,
  isWebUrl,
  navigationAllowed,
  nextZoom,
  pagesToDiscard,
  permissionKey,
  permissionVerdict,
  popupDisposition,
  shortcutFor,
  uniqueFileName,
  viewBounds,
} from './browserGuard.ts'
import { BrowserAgent } from './browserAgent.ts'
import { PortForwards } from './portForward.ts'

/** Sent to the app page for everything the pane's pages do (see preload.ts). */
export const BROWSER_EVENT = 'beddcode:browser-event'

/** Hidden pages unused this long are closed (their tab and address stay). */
const DISCARD_IDLE_MS = Number(process.env.BEDDCODE_BROWSER_DISCARD_MS) || 20 * 60_000
/** At most this many pages stay loaded; the least recently shown hidden ones go first. */
const MAX_LIVE_PAGES = 8
/** A permission or sign-in prompt nobody answers is refused after this long. */
const PROMPT_TIMEOUT_MS = 5 * 60_000

interface Page {
  tabId: number
  view: WebContentsView | null
  url: string
  title: string
  favicon?: string
  zoom: number
  lastShown: number
  visible: boolean
  console: ConsoleLog
  findText?: string
  /** The agent driving this tab, if one is (see `agent-control`). */
  agent: string | null
}

/** Size a hidden agent tab renders at when the pane was never laid out. */
const PARKED_SIZE = { width: 1280, height: 800 }

/**
 * The browser pane's pages, one native WebContentsView per tab, laid over the pane by the app
 * page. Replaces the `<webview>` tag Electron advises against: each page is its own WebContents
 * owned by the main process, so a page keeps running while the pane is hidden, a crash takes only
 * that page, and every permission, download, sign-in and certificate question comes through here.
 */
export class BrowserViews {
  private pages = new Map<number, Page>()
  private visibleTab: number | null = null
  private readonly sweep: NodeJS.Timeout
  private readonly agent = new BrowserAgent()

  constructor(
    private readonly win: BrowserWindow,
    private readonly shared: BrowserShared,
  ) {
    shared.windows.add(this)
    this.sweep = setInterval(() => this.discardIdle(), 60_000)
    this.sweep.unref()
    // A reload of the app page starts its tabs over; pages it no longer knows must go.
    win.webContents.on('did-navigate', () => this.closeAll())
    win.webContents.on('render-process-gone', () => this.closeAll())
    // Hidden agent tabs sit at the window's corner (see park); it moves when the window resizes.
    win.on('resize', () => {
      for (const page of this.pages.values()) if (page.agent && !page.visible) this.park(page)
    })
    win.on('closed', () => {
      clearInterval(this.sweep)
      shared.windows.delete(this)
      this.closeAll()
    })
  }

  isWindow(win: BrowserWindow | null | undefined): boolean {
    return win === this.win
  }

  owns(contents: WebContents): boolean {
    for (const page of this.pages.values()) if (page.view?.webContents === contents) return true
    return false
  }

  tabOf(contents: WebContents): number | undefined {
    for (const page of this.pages.values())
      if (page.view?.webContents === contents) return page.tabId
    return undefined
  }

  send(event: BrowserEvent): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(BROWSER_EVENT, event)
  }

  private state(tabId: number, state: Partial<BrowserPageState>) {
    this.send({ type: 'state', tabId, state })
  }

  async handle(command: BrowserCommand): Promise<unknown> {
    switch (command.op) {
      case 'ensure': {
        const page = this.pages.get(command.tabId)
        if (page?.view) return true
        this.create(command.tabId, page?.url && page.url !== 'about:blank' ? page.url : command.url)
        return true
      }
      case 'navigate': {
        const page = this.pages.get(command.tabId)
        if (!page?.view) return void this.create(command.tabId, command.url)
        this.load(page, command.url)
        return true
      }
      case 'close':
        this.close(command.tabId)
        return true
      case 'layout':
        this.radius = command.radius ?? 0
        this.layout(command.tabId, command.bounds)
        return true
      case 'permission':
        return this.shared.answerPermission(command.id, command.allow)
      case 'login':
        return this.shared.answerLogin(command.id, command.username, command.password)
      case 'reveal-download':
        return this.shared.revealDownload(command.id)
      case 'open-external':
        if (!isWebUrl(command.url)) return false
        await shell.openExternal(command.url)
        return true
      case 'forward-port':
        return this.shared.forwards.forward(command)
      case 'clear-data':
        await this.shared.session.clearStorageData()
        await this.shared.session.clearCache()
        this.shared.permissions.clear()
        return true
      case 'agent-control': {
        const page = this.pages.get(command.tabId)
        if (!page) return false
        page.agent = command.agent
        if (!page.view) return true
        if (command.agent) {
          if (!page.visible) this.park(page)
        } else {
          this.agent.detach(page.view.webContents)
          if (!page.visible) this.unpark(page)
        }
        return true
      }
      case 'agent': {
        const page = this.pages.get(command.tabId)
        const contents = page?.view?.webContents
        if (!page || !contents || contents.isDestroyed())
          return {
            ok: false,
            error: 'The tab has no page loaded. Open it again with browser_tabs.',
          }
        if (!page.agent) page.agent = command.action.agent
        if (!page.visible) this.park(page)
        return this.agent.run(
          {
            tabId: page.tabId,
            contents,
            console: page.console,
            load: (url) => this.load(page, url),
          },
          command.action,
        )
      }
    }
    const page = this.pages.get(command.tabId)
    const contents = page?.view?.webContents
    if (!page || !contents || contents.isDestroyed()) return null
    switch (command.op) {
      case 'back':
        if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
        return true
      case 'forward':
        if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
        return true
      case 'reload':
      case 'hard-reload':
        // A crashed page has no renderer to reload in place: load its address again.
        if (contents.isCrashed()) this.load(page, page.url)
        else if (command.op === 'hard-reload') contents.reloadIgnoringCache()
        else contents.reload()
        this.state(page.tabId, { crashed: undefined, unresponsive: false, error: undefined })
        return true
      case 'stop':
        contents.stop()
        return true
      case 'devtools':
        if (contents.isDevToolsOpened()) contents.devToolsWebContents?.focus()
        else contents.openDevTools({ mode: 'detach' })
        return true
      case 'focus':
        contents.focus()
        return true
      case 'zoom':
        page.zoom = nextZoom(page.zoom, command.direction)
        contents.setZoomFactor(page.zoom)
        this.state(page.tabId, { zoom: page.zoom })
        return page.zoom
      case 'find':
        if (!command.text) {
          contents.stopFindInPage('clearSelection')
          this.state(page.tabId, { found: undefined })
          return null
        }
        page.findText = command.text
        return contents.findInPage(command.text, {
          forward: command.forward ?? true,
          // Electron's findNext means "start a new search", the opposite of what it sounds like.
          findNext: !command.next,
        })
      case 'stop-find':
        page.findText = undefined
        contents.stopFindInPage('keepSelection')
        this.state(page.tabId, { found: undefined })
        return true
      case 'capture': {
        const image = await contents.capturePage(command.rect && roundRect(command.rect))
        return image.isEmpty() ? null : image.toDataURL()
      }
      case 'pdf': {
        const data = await contents.printToPDF({ printBackground: true })
        const base = (page.title || new URL(page.url).hostname || 'page').slice(0, 80)
        const dir = app.getPath('downloads')
        const name = uniqueFileName(`${base}.pdf`, (n) => existsSync(path.join(dir, n)))
        const file = path.join(dir, name)
        writeFileSync(file, data)
        const id = this.shared.rememberDownload(file)
        this.send({
          type: 'download',
          id,
          filename: name,
          state: 'completed',
          received: data.length,
          total: data.length,
        })
        return name
      }
      case 'exec':
        return contents.executeJavaScript(command.code, true)
      case 'console':
        return page.console.list()
      case 'clear-console':
        page.console.clear()
        this.state(page.tabId, { consoleErrors: 0 })
        return true
    }
    return null
  }

  private create(tabId: number, url: string) {
    const existing = this.pages.get(tabId)
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        safeDialogs: true,
        navigateOnDragDrop: false,
        spellcheck: true,
      },
    })
    view.setBackgroundColor('#ffffff')
    // Attached to the window only while shown (see layout).
    const page: Page = existing ?? {
      tabId,
      view: null,
      url,
      title: '',
      zoom: 1,
      lastShown: Date.now(),
      visible: false,
      console: new ConsoleLog(),
      agent: null,
    }
    page.view = view
    page.visible = false
    this.pages.set(tabId, page)
    this.wire(page, view.webContents)
    if (page.zoom !== 1) view.webContents.setZoomFactor(page.zoom)
    this.state(tabId, {
      discarded: false,
      crashed: undefined,
      unresponsive: false,
      error: undefined,
      consoleErrors: page.console.errors,
      zoom: page.zoom,
    })
    this.load(page, url)
    // A tab shown before its page existed gets it laid out at once.
    if (this.visibleTab === tabId && this.lastBounds) this.layout(tabId, this.lastRect)
    else if (page.agent) this.park(page)
  }

  private load(page: Page, url: string) {
    const contents = page.view?.webContents
    if (!contents || !navigationAllowed(url)) return
    page.url = url
    this.state(page.tabId, { error: undefined, crashed: undefined })
    contents.loadURL(url).catch(() => {
      // Reported through did-fail-load.
    })
  }

  private wire(page: Page, contents: WebContents) {
    const tabId = page.tabId
    const nav = () => {
      if (contents.isDestroyed()) return
      this.state(tabId, {
        back: contents.navigationHistory.canGoBack(),
        forward: contents.navigationHistory.canGoForward(),
      })
    }
    contents.on('did-start-loading', () => this.state(tabId, { loading: true }))
    contents.on('did-stop-loading', () => {
      this.state(tabId, { loading: false })
      nav()
    })
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        page.console.clear()
        // Another site's icon would be wrong until (or if) the new one arrives.
        const otherSite = originOf(details.url) !== originOf(contents.getURL())
        if (otherSite) page.favicon = ''
        this.state(tabId, {
          error: undefined,
          consoleErrors: 0,
          found: undefined,
          ...(otherSite ? { favicon: '' } : {}),
        })
      }
    })
    const navigated = (url: string) => {
      page.url = url
      this.state(tabId, { url })
      nav()
    }
    contents.on('did-navigate', (_e, url) => navigated(url))
    contents.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (isMainFrame) navigated(url)
    })
    contents.on('page-title-updated', (_e, title) => {
      page.title = title
      this.state(tabId, { title })
    })
    contents.on('page-favicon-updated', (_e, favicons) => {
      const favicon = favicons.find((f) => /^(https?|data):/i.test(f))
      if (favicon) {
        page.favicon = favicon
        this.state(tabId, { favicon })
      }
    })
    contents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
      // -3 is an aborted load (a new navigation, or Stop), not a failure.
      if (!isMainFrame || code === -3) return
      page.console.push({
        level: 'error',
        message: `${description} (${code}) ${url}`,
        time: Date.now(),
      })
      this.state(tabId, {
        error: { code, description, url },
        loading: false,
        consoleErrors: page.console.errors,
      })
    })
    contents.on('render-process-gone', (_e, details) => {
      if (details.reason === 'clean-exit') return
      page.console.push({
        level: 'error',
        message: `The page's process ended: ${details.reason}`,
        time: Date.now(),
      })
      this.state(tabId, { crashed: details.reason, loading: false, unresponsive: false })
    })
    // 'responsive' does not always follow 'unresponsive' (seen with WebContentsView in
    // Electron 38), so the page is also asked for a sign of life until it answers.
    let lifeCheck: ReturnType<typeof setInterval> | null = null
    let asking = false
    const responsive = () => {
      if (lifeCheck) clearInterval(lifeCheck)
      lifeCheck = null
      if (!contents.isDestroyed()) this.state(tabId, { unresponsive: false })
    }
    contents.on('unresponsive', () => {
      this.state(tabId, { unresponsive: true })
      if (lifeCheck) return
      lifeCheck = setInterval(() => {
        if (contents.isDestroyed()) return responsive()
        if (asking) return
        asking = true
        void contents
          .executeJavaScript('0', false)
          .then(responsive, () => {})
          .finally(() => (asking = false))
      }, 2000)
    })
    contents.on('responsive', responsive)
    contents.once('destroyed', () => lifeCheck && clearInterval(lifeCheck))
    let pendingConsole: NodeJS.Timeout | null = null
    contents.on('console-message', (details) => {
      // Electron's own advice to app developers, printed in every page of an unpackaged app.
      if (details.message.includes('Electron Security Warning')) return
      page.console.push({
        level: details.level,
        message: details.message.slice(0, 4000),
        source: details.sourceId || undefined,
        line: details.lineNumber || undefined,
        time: Date.now(),
      })
      if (details.level === 'error' && !pendingConsole) {
        pendingConsole = setTimeout(() => {
          pendingConsole = null
          this.state(tabId, { consoleErrors: page.console.errors })
        }, 250)
      }
    })
    contents.on('found-in-page', (_e, result) => {
      if (result.finalUpdate || result.matches !== undefined) {
        this.state(tabId, {
          found: { active: result.activeMatchOrdinal, matches: result.matches },
        })
      }
    })
    contents.on('zoom-changed', (_e, direction) => {
      page.zoom = nextZoom(page.zoom, direction === 'in' ? 1 : -1)
      contents.setZoomFactor(page.zoom)
      this.state(tabId, { zoom: page.zoom })
    })
    // The user clicking or typing in a page an agent drives takes it over (the agent's own input
    // arrives while an action runs).
    contents.on('input-event', (_e, input) => {
      if (!page.agent || !page.visible || this.agent.busy(contents)) return
      if (input.type === 'mouseDown' || input.type === 'rawKeyDown' || input.type === 'keyDown')
        this.send({ type: 'user-input', tabId })
    })
    contents.on('before-input-event', (event, input) => {
      const action = shortcutFor(input, process.platform)
      if (!action) return
      event.preventDefault()
      switch (action) {
        case 'find':
        case 'focus-address':
        case 'new-tab':
        case 'close-tab':
          this.send({ type: 'shortcut', tabId, action })
          return
        case 'zoom-in':
        case 'zoom-out':
        case 'zoom-reset':
          void this.handle({
            op: 'zoom',
            tabId,
            direction: action === 'zoom-in' ? 1 : action === 'zoom-out' ? -1 : 0,
          })
          return
        default:
          void this.handle({ op: action, tabId })
      }
    })
    // Only web pages: a page cannot send the view to file:, chrome:, javascript: and the like.
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (navigationAllowed(url)) return
      event.preventDefault()
      if (/^mailto:/i.test(url)) void shell.openExternal(url)
    }
    contents.on('will-navigate', (event) => guard(event, event.url))
    contents.on('will-redirect', (event) => guard(event, event.url))
    contents.setWindowOpenHandler(({ url, disposition, features }) => {
      const where = popupDisposition(url, disposition, features)
      if (where === 'tab') this.send({ type: 'open', url, tabId })
      if (where !== 'window') return { action: 'deny' }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          parent: this.win,
          width: 520,
          height: 700,
          autoHideMenuBar: true,
          backgroundColor: '#ffffff',
          webPreferences: {
            partition: BROWSER_PARTITION,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            safeDialogs: true,
          },
        },
      }
    })
    contents.on('did-create-window', (child) => this.shared.guardPopup(child.webContents))
  }

  private radius = 0
  private lastBounds = false
  private lastRect: BrowserRect | null = null

  private layout(tabId: number | null, rect: BrowserRect | null) {
    const bounds = viewBounds(rect, this.win.webContents.getZoomFactor())
    this.lastRect = rect
    this.lastBounds = bounds !== null
    this.visibleTab = tabId
    const now = Date.now()
    for (const page of this.pages.values()) {
      const show = bounds !== null && page.tabId === tabId && page.view !== null
      if (page.visible || show) page.lastShown = now
      if (!page.view) continue
      if (show) {
        page.view.setBounds(bounds!)
        page.view.setBorderRadius(Math.round(this.radius * this.win.webContents.getZoomFactor()))
      }
      if (page.visible !== show) {
        page.visible = show
        // Detached rather than merely hidden: only then does the page learn it is hidden
        // (document.hidden, visibilitychange) and get throttled like a background tab. An agent's
        // tab is parked instead, so it keeps rendering for the agent to look at.
        if (show) {
          if (!this.win.contentView.children.includes(page.view))
            this.win.contentView.addChildView(page.view)
        } else if (page.agent) this.park(page)
        else this.win.contentView.removeChildView(page.view)
      }
    }
    // The shown tab's page may have been discarded: bring it back.
    const page = tabId === null ? undefined : this.pages.get(tabId)
    if (bounds && page && !page.view) this.create(page.tabId, page.url)
  }

  /**
   * Keeps a hidden page rendering: attached, but placed so that only its top-left pixel overlaps
   * the window's bottom-right corner, where the rounded corner clips it. Chromium then treats it
   * as visible (it paints, runs animation frames, can be captured) without the user seeing it. A
   * detached or setVisible(false) view stops painting, and screenshots of it hang.
   */
  private park(page: Page) {
    const view = page.view
    if (!view || this.win.isDestroyed()) return
    const [w, h] = this.win.getContentSize() as [number, number]
    const size = this.lastParkSize()
    view.setBounds({ x: Math.max(0, w - 1), y: Math.max(0, h - 1), ...size })
    view.setBorderRadius(16)
    if (!this.win.contentView.children.includes(view)) this.win.contentView.addChildView(view)
  }

  private unpark(page: Page) {
    const view = page.view
    if (view && !this.win.isDestroyed() && this.win.contentView.children.includes(view))
      this.win.contentView.removeChildView(view)
  }

  /** A parked page renders at the size it has when shown, so what the agent sees matches. */
  private lastParkSize() {
    const bounds = viewBounds(this.lastRect, this.win.webContents.getZoomFactor())
    return bounds && bounds.width > 200 && bounds.height > 200
      ? { width: bounds.width, height: bounds.height }
      : PARKED_SIZE
  }

  private discardIdle() {
    const live = [...this.pages.values()].filter((p) => p.view && !p.view.webContents.isDestroyed())
    const ids = pagesToDiscard(
      live.map((p) => ({
        id: p.tabId,
        visible: p.visible,
        lastShown: p.lastShown,
        busy:
          p.agent !== null ||
          p.view!.webContents.isCurrentlyAudible() ||
          p.view!.webContents.isDevToolsOpened() ||
          this.shared.hasPrompt(p.view!.webContents),
      })),
      Date.now(),
      { idleMs: DISCARD_IDLE_MS, maxLive: MAX_LIVE_PAGES },
    )
    for (const id of ids) {
      const page = this.pages.get(id)
      if (!page?.view) continue
      this.destroyView(page)
      this.state(id, { discarded: true, loading: false })
    }
  }

  private destroyView(page: Page) {
    const view = page.view
    page.view = null
    page.visible = false
    if (!view) return
    this.shared.dropPrompts(view.webContents)
    if (!this.win.isDestroyed() && this.win.contentView.children.includes(view))
      this.win.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  }

  private close(tabId: number) {
    const page = this.pages.get(tabId)
    if (!page) return
    this.destroyView(page)
    this.pages.delete(tabId)
  }

  private closeAll() {
    for (const id of this.pages.keys()) this.close(id)
  }
}

function roundRect(rect: BrowserRect) {
  const x = Math.max(0, Math.floor(rect.x))
  const y = Math.max(0, Math.floor(rect.y))
  return {
    x,
    y,
    width: Math.max(1, Math.ceil(rect.x + rect.width) - x),
    height: Math.max(1, Math.ceil(rect.y + rect.height) - y),
  }
}

interface Prompt {
  kind: 'permission' | 'login'
  contents: WebContents
  resolve(answer: unknown): void
  timer: NodeJS.Timeout
}

/**
 * What every window's pages share: the session (cookies, permissions, downloads), questions
 * waiting for the user, and port forwards.
 */
export class BrowserShared {
  readonly windows = new Set<BrowserViews>()
  readonly permissions = new Map<string, boolean>()
  readonly forwards = new PortForwards()
  private prompts = new Map<string, Prompt>()
  private downloads = new Map<string, string>()
  private nextId = 1
  readonly session: Session

  constructor() {
    this.session = electronSession.fromPartition(BROWSER_PARTITION)
    this.guardSession()
    app.on('certificate-error', (event, contents, url, _error, _certificate, callback) => {
      // A dev server on this machine with a self-signed certificate is the usual case; anything
      // else keeps Chromium's refusal and shows as a load error in the pane.
      if (contents.session === this.session && isLoopbackUrl(url)) {
        event.preventDefault()
        callback(true)
      }
    })
    app.on('login', (event, contents, details, authInfo, callback) => {
      if (!contents || contents.session !== this.session) return
      event.preventDefault()
      const owner = this.ownerOf(contents)
      const id = this.prompt('login', contents, (answer) => {
        const { username, password } = (answer ?? {}) as { username?: string; password?: string }
        if (username === undefined) callback()
        else callback(username, password ?? '')
      })
      owner?.views.send({
        type: 'login',
        id,
        tabId: owner.tabId,
        host: authInfo.host || new URL(details.url).host,
        realm: authInfo.realm || undefined,
        proxy: authInfo.isProxy,
      })
      if (!owner) this.answerLogin(id)
    })
  }

  private ownerOf(contents: WebContents): { views: BrowserViews; tabId?: number } | undefined {
    for (const views of this.windows) {
      const tabId = views.tabOf(contents)
      if (tabId !== undefined) return { views, tabId }
    }
    // A sign-in popup: ask in the window that opened it.
    const parent = BrowserWindow.fromWebContents(contents)?.getParentWindow()
    for (const views of this.windows) if (views.isWindow(parent)) return { views }
    return [...this.windows][0] ? { views: [...this.windows][0]! } : undefined
  }

  private guardSession() {
    const s = this.session
    s.setPermissionRequestHandler((contents, permission, callback, details) => {
      const origin = originOf(details.requestingUrl ?? contents.getURL())
      const mediaTypes =
        'mediaTypes' in details ? (details.mediaTypes as string[] | undefined) : undefined
      const key = permissionKey(origin, permission, mediaTypes)
      const verdict = permissionVerdict(permission, this.permissions.get(key))
      if (verdict !== 'ask') return callback(verdict === 'allow')
      const owner = this.ownerOf(contents)
      if (!owner) return callback(false)
      const id = this.prompt('permission', contents, (answer) => {
        const allow = answer === true
        this.permissions.set(key, allow)
        callback(allow)
      })
      owner.views.send({
        type: 'permission',
        id,
        tabId: owner.tabId,
        origin,
        permission,
        mediaTypes,
      })
    })
    s.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      const verdict = permissionVerdict(
        permission,
        this.permissions.get(permissionKey(originOf(requestingOrigin), permission)),
      )
      return verdict === 'allow'
    })
    // Devices a page could reach directly are never offered.
    s.setDevicePermissionHandler(() => false)
    s.on('will-download', (_event, item) => {
      const dir = app.getPath('downloads')
      const name = uniqueFileName(item.getFilename(), (n) => existsSync(path.join(dir, n)))
      const file = path.join(dir, name)
      item.setSavePath(file)
      const id = this.rememberDownload(file)
      let last = 0
      const report = (state: 'progressing' | 'completed' | 'cancelled' | 'interrupted') => {
        for (const views of this.windows)
          views.send({
            type: 'download',
            id,
            filename: name,
            state,
            received: item.getReceivedBytes(),
            total: item.getTotalBytes(),
          })
      }
      report('progressing')
      item.on('updated', (_e, state) => {
        const now = Date.now()
        if (state === 'interrupted') return report('interrupted')
        if (now - last > 300) {
          last = now
          report('progressing')
        }
      })
      item.once('done', (_e, state) => report(state))
    })
  }

  /** Popup windows (sign-in) get the same rules as the pane's pages. */
  guardPopup(contents: WebContents) {
    const guard = (event: { preventDefault(): void; url: string }) => {
      if (!navigationAllowed(event.url)) event.preventDefault()
    }
    contents.on('will-navigate', guard)
    contents.on('will-redirect', guard)
    contents.setWindowOpenHandler(({ url }) => {
      const owner = [...this.windows][0]
      if (owner && isWebUrl(url)) owner.send({ type: 'open', url })
      return { action: 'deny' }
    })
  }

  rememberDownload(file: string): string {
    const id = `d${this.nextId++}`
    this.downloads.set(id, file)
    return id
  }

  revealDownload(id: string): boolean {
    const file = this.downloads.get(id)
    if (!file) return false
    shell.showItemInFolder(file)
    return true
  }

  private prompt(
    kind: Prompt['kind'],
    contents: WebContents,
    resolve: (answer: unknown) => void,
  ): string {
    const id = `p${this.nextId++}`
    const timer = setTimeout(() => this.settle(id, undefined), PROMPT_TIMEOUT_MS)
    timer.unref()
    this.prompts.set(id, { kind, contents, resolve, timer })
    return id
  }

  private settle(id: string, answer: unknown, kind?: Prompt['kind']) {
    const prompt = this.prompts.get(id)
    if (!prompt || (kind && prompt.kind !== kind)) return false
    this.prompts.delete(id)
    clearTimeout(prompt.timer)
    prompt.resolve(answer)
    const type = prompt.kind === 'login' ? 'login-done' : 'permission-done'
    for (const views of this.windows) views.send({ type, id })
    return true
  }

  answerPermission(id: string, allow: boolean): boolean {
    return this.settle(id, allow === true, 'permission')
  }

  answerLogin(id: string, username?: string, password?: string): boolean {
    return this.settle(id, username === undefined ? undefined : { username, password }, 'login')
  }

  hasPrompt(contents: WebContents): boolean {
    for (const p of this.prompts.values()) if (p.contents === contents) return true
    return false
  }

  /** A page going away refuses whatever it was still asking. */
  dropPrompts(contents: WebContents) {
    for (const [id, p] of this.prompts) if (p.contents === contents) this.settle(id, undefined)
  }
}

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}
