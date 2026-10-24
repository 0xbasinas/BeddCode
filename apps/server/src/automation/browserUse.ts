import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type {
  BrowserToolName,
  BrowserUnavailable,
  BrowserUseCall,
  BrowserUseResult,
  ClientFrame,
  ServerFrame,
} from '@beddcode/contracts'

// Browser use: the host lists browser_* tools to agents of sessions that may use the browser and
// runs each call on a connected desktop app, which owns the browser pane and its pages.

const tab = {
  type: 'number',
  description: 'Tab id from browser_tabs; your current tab if omitted.',
}
const ref = {
  type: 'string',
  description: 'Element ref from the latest browser_snapshot, e.g. "e12".',
}

/** The tools, as MCP lists them. */
export const BROWSER_TOOL_DEFINITIONS = [
  {
    name: 'browser_tabs',
    description:
      "Lists, opens, selects or closes your tabs in the BeddCode browser pane. You get tabs of your own; the user's tabs are listed but you can only take one over after they agree. Opening makes the new tab your current one.",
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'open', 'select', 'close'] },
        url: { type: 'string', description: 'For open: the address to load (http or https).' },
        tab: { type: 'number', description: 'For select and close: the tab id.' },
      },
      required: ['action'],
    },
  },
  {
    name: 'browser_navigate',
    description:
      'Loads an http(s) address in your current tab (opening one if you have none) and waits for it. localhost means the machine BeddCode runs agents on.',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string' }, tab },
      required: ['url'],
    },
  },
  {
    name: 'browser_back',
    description: 'Goes back in the tab history.',
    inputSchema: { type: 'object', properties: { tab } },
  },
  {
    name: 'browser_forward',
    description: 'Goes forward in the tab history.',
    inputSchema: { type: 'object', properties: { tab } },
  },
  {
    name: 'browser_reload',
    description: 'Reloads the page.',
    inputSchema: { type: 'object', properties: { tab } },
  },
  {
    name: 'browser_snapshot',
    description:
      'The page as an accessibility tree: roles, names, values and states, with a ref like [ref=e5] on each element you can act on. Take one before acting and again after the page changes. Refs stay the same while their element exists.',
    inputSchema: { type: 'object', properties: { tab } },
  },
  {
    name: 'browser_click',
    description: 'Clicks an element (scrolled into view first) with real mouse input.',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        double: { type: 'boolean', description: 'Double-click.' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        tab,
      },
      required: ['ref'],
    },
  },
  {
    name: 'browser_type',
    description:
      'Types text into an input, text area or editable element. Replaces what is there unless clear is false.',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        text: { type: 'string' },
        clear: { type: 'boolean', description: 'Clear the field first (default true).' },
        submit: { type: 'boolean', description: 'Press Enter afterwards.' },
        tab,
      },
      required: ['ref', 'text'],
    },
  },
  {
    name: 'browser_press_key',
    description:
      'Presses a key or a combination: "Enter", "Escape", "Tab", "ArrowDown", "Backspace", "Control+a", "a". Goes to the element with ref (focused first) or the focused element.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' }, ref, tab },
      required: ['key'],
    },
  },
  {
    name: 'browser_hover',
    description: 'Moves the mouse over an element (real :hover, menus, tooltips).',
    inputSchema: { type: 'object', properties: { ref, tab }, required: ['ref'] },
  },
  {
    name: 'browser_select_option',
    description: 'Chooses options in a <select> by value or visible label.',
    inputSchema: {
      type: 'object',
      properties: { ref, values: { type: 'array', items: { type: 'string' } }, tab },
      required: ['ref', 'values'],
    },
  },
  {
    name: 'browser_scroll',
    description:
      'Scrolls an element into view (with ref), or scrolls the page (or the element under ref) by an amount in a direction.',
    inputSchema: {
      type: 'object',
      properties: {
        ref,
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        amount: { type: 'number', description: 'Pixels; about a screen when omitted.' },
        tab,
      },
    },
  },
  {
    name: 'browser_wait_for',
    description:
      'Waits until text appears (text), disappears (text_gone), an element matches a CSS selector, or the address contains url; or for timeout_seconds when none is given. At most 30 s.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        text_gone: { type: 'string' },
        selector: { type: 'string' },
        url: { type: 'string' },
        timeout_seconds: { type: 'number' },
        tab,
      },
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'A picture of the visible part of the page. Use browser_snapshot to find elements; use this to check how it looks.',
    inputSchema: { type: 'object', properties: { tab } },
  },
  {
    name: 'browser_console',
    description: "The page's console messages and failed loads since it loaded, newest last.",
    inputSchema: {
      type: 'object',
      properties: {
        level: {
          type: 'string',
          enum: ['error', 'warning', 'all'],
          description: 'Errors only, errors and warnings, or everything (default all).',
        },
        limit: { type: 'number', description: 'At most this many, newest (default 50).' },
        tab,
      },
    },
  },
  {
    name: 'browser_evaluate',
    description:
      'Runs JavaScript in the page and returns its JSON result. An expression or a function body with return; promises are awaited. The user may have to approve it. Prefer snapshot and the other tools.',
    inputSchema: {
      type: 'object',
      properties: { script: { type: 'string' }, tab },
      required: ['script'],
    },
  },
] as const

export const BROWSER_INSTRUCTIONS =
  "BeddCode browser tools drive tabs of the user's BeddCode desktop app browser pane. Open a tab " +
  '(browser_tabs open, or browser_navigate), read it with browser_snapshot, act on element refs ' +
  '(browser_click, browser_type...), and check results with browser_wait_for, browser_snapshot, ' +
  'browser_screenshot and browser_console. The user watches and can take over at any time; if a ' +
  'tool says they did, stop using the browser and ask them how to go on.'

/** How long a call may take on the desktop app before the agent is told. */
const CALL_TIMEOUT_MS = 45_000

interface Client {
  id: number
  send(frame: ServerFrame): void
  available: boolean
  reason?: BrowserUnavailable
  focus?: { sessionId: string; at: number }
  connectedAt: number
}

interface Pending {
  client: number
  resolve(result: BrowserUseResult): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The host's connected clients that can run browser tools, and the calls waiting on them. A
 * session keeps using the client it started on (its tabs live there) while that one stays.
 */
export class BrowserBroker {
  private readonly clients = new Map<number, Client>()
  private readonly sticky = new Map<string, number>()
  private readonly pending = new Map<string, Pending>()
  private nextClient = 1
  private nextCall = 1

  /** A new WebSocket connection; it takes part once it offers. */
  connect(send: (frame: ServerFrame) => void) {
    const client: Client = {
      id: this.nextClient++,
      send,
      available: false,
      connectedAt: Date.now(),
    }
    let offered = false
    return {
      frame: (frame: Extract<ClientFrame, { t: 'browser.offer' | 'browser.result' }>) => {
        if (frame.t === 'browser.offer') {
          client.available = frame.available
          client.reason = frame.reason
          client.focus = frame.focus
          if (!offered) this.clients.set(client.id, client)
          offered = true
          if (!frame.available)
            this.forget(client.id, 'The BeddCode desktop app stopped offering its browser')
          return
        }
        const p = this.pending.get(frame.id)
        if (!p || p.client !== client.id) return
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        p.resolve(frame.result)
      },
      close: () => {
        this.clients.delete(client.id)
        this.forget(client.id, 'The BeddCode desktop app running the browser disconnected')
      },
    }
  }

  private forget(clientId: number, why: string) {
    for (const [session, id] of this.sticky) if (id === clientId) this.sticky.delete(session)
    for (const [callId, p] of this.pending) {
      if (p.client !== clientId) continue
      this.pending.delete(callId)
      clearTimeout(p.timer)
      p.resolve({ ok: false, error: why })
    }
  }

  /** The client that should run a session's calls, or why there is none. */
  pick(sessionId: string): Client | string {
    const able = [...this.clients.values()].filter((c) => c.available)
    if (!able.length) {
      const others = [...this.clients.values()]
      if (others.some((c) => c.reason === 'web' || c.reason === 'mobile'))
        return 'The browser tools need the BeddCode desktop app. Only the web or phone app is connected to this host right now, and those cannot run a browser for you. Ask the user to open the desktop app.'
      return 'No BeddCode desktop app is connected to this host, so there is no browser to use. Ask the user to open the BeddCode desktop app (connected to this host) and try again.'
    }
    const stuck = this.sticky.get(sessionId)
    const same = able.find((c) => c.id === stuck)
    if (same) return same
    // The app showing this session, else the one the user looked at last, else the newest.
    const showing = able
      .filter((c) => c.focus?.sessionId === sessionId)
      .sort((a, b) => b.focus!.at - a.focus!.at)[0]
    if (showing) return showing
    return able.sort((a, b) => (b.focus?.at ?? b.connectedAt) - (a.focus?.at ?? a.connectedAt))[0]!
  }

  /** Runs one call on the session's client. */
  call(call: BrowserUseCall, timeoutMs = CALL_TIMEOUT_MS): Promise<BrowserUseResult> {
    const client = this.pick(call.sessionId)
    if (typeof client === 'string') return Promise.resolve({ ok: false, error: client })
    this.sticky.set(call.sessionId, client.id)
    const id = `b${this.nextCall++}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({
          ok: false,
          error: `The browser did not answer within ${Math.round(timeoutMs / 1000)} s. The page may be busy; try browser_snapshot or browser_screenshot.`,
        })
      }, timeoutMs)
      this.pending.set(id, { client: client.id, resolve, timer })
      client.send({ t: 'browser.call', id, call })
    })
  }

  /** How many clients can run calls (for tests and diagnostics). */
  get size(): number {
    return [...this.clients.values()].filter((c) => c.available).length
  }
}

/** What the browser tools need from the rest of the host. */
export interface BrowserToolsHost {
  currentMode(sessionId: string): string | undefined
  /** The agent's name ("Claude") and the session's title. */
  describe(sessionId: string): Promise<{ agent: string; title?: string }>
  askUser(sessionId: string, ask: { title: string; detail?: string }): Promise<boolean>
  modeLevel(mode: string): number
}

type McpContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface McpResult {
  content: McpContent[]
  isError?: boolean
}

const fail = (text: string): McpResult => ({ content: [{ type: 'text', text }], isError: true })

export class BrowserTools {
  private shots = 0

  constructor(
    readonly broker: BrowserBroker,
    private readonly host: BrowserToolsHost,
    /** Where pictures of the pages are kept for the conversation's tool cards. */
    private readonly imageDir: string,
  ) {}

  async call(
    sessionId: string,
    tool: BrowserToolName,
    args: Record<string, unknown>,
  ): Promise<McpResult> {
    const level = this.host.modeLevel(this.host.currentMode(sessionId) ?? 'default')
    const { agent, title } = await this.host.describe(sessionId)
    if (tool === 'browser_evaluate' && level < 3) {
      const script = typeof args.script === 'string' ? args.script : ''
      const ok = await this.host.askUser(sessionId, {
        title: `Let ${agent} run JavaScript in the browser?`,
        detail: script.slice(0, 2000),
      })
      if (!ok) return fail('The user did not allow running this script.')
    }
    const call: BrowserUseCall = {
      sessionId,
      tool,
      args,
      agent,
      sessionTitle: title,
      confirmSubmits: level <= 1,
    }
    const timeout =
      tool === 'browser_wait_for'
        ? (Math.min(Math.max(Number(args.timeout_seconds) || 10, 0), 30) + 15) * 1000
        : undefined
    let result = await this.broker.call(call, timeout)
    if (!result.ok && 'needsApproval' in result) {
      const ok = await this.host.askUser(sessionId, result.needsApproval)
      if (!ok) return fail(`The user said no: ${result.needsApproval.title}`)
      result = await this.broker.call({ ...call, approved: true }, timeout)
    }
    if (!result.ok) return fail('error' in result ? result.error : 'The browser refused the action')
    const lines = [result.text]
    const picture = result.image ?? result.thumb
    if (picture) {
      const file = this.save(sessionId, picture)
      if (file) lines.unshift(`image: ${file}`)
    }
    const content: McpContent[] = [{ type: 'text', text: lines.join('\n') }]
    if (result.image)
      content.push({ type: 'image', data: result.image.data, mimeType: result.image.mime })
    return { content }
  }

  private save(sessionId: string, image: { data: string; mime: string }): string | undefined {
    try {
      const dir = path.join(this.imageDir, sessionId.replace(/[^\w-]/g, '_'))
      mkdirSync(dir, { recursive: true })
      const ext = image.mime === 'image/png' ? 'png' : 'jpg'
      const file = path.join(dir, `${Date.now()}-${++this.shots}.${ext}`)
      writeFileSync(file, Buffer.from(image.data, 'base64'))
      return file
    } catch {
      return undefined
    }
  }
}
