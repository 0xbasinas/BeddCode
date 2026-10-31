import type {
  ClickTarget,
  DesktopDriver,
  DesktopWindow,
  FailCode,
  InputOptions,
  Outcome,
  Snapshot,
} from './driver.ts'
import { readFields, regionsOf, type RunScript } from './uiaSecrets.ts'
import { restoreMinimizedWindow } from './windowRestore.ts'

// A DesktopDriver on Cua Driver (@trycua/cua-driver, MIT): UI Automation for the tree and for
// clicks that do not move the user's mouse, Windows Graphics Capture for pictures, and SendInput or
// PostMessage for keys. It runs in this process; there is no daemon.

/** The part of the SDK's client this driver uses (so tests can stand in for the native library). */
export interface CuaClient {
  callTool(
    name: string,
    argumentsJson: string,
  ): Promise<{
    text: string
    images: Array<{ mimeType: string; dataBase64: string }>
    isError: boolean
    rawJson: string
  }>
  shutdown(): Promise<void>
  uniffiDestroy?(): void
}

type Raw = Awaited<ReturnType<CuaClient['callTool']>>

/** Maps the driver's refusals to codes an agent can act on. */
export function failCode(text: string): FailCode {
  if (/UIPI|higher-integrity|High integrity/i.test(text)) return 'elevated'
  if (
    /Background delivery is not available|could not find a UIA AcceleratorKey|PostMessage WM_KEYDOWN\/?UP is ignored by this target's input pipeline/i.test(
      text,
    )
  )
    return 'foreground_needed'
  if (/token is stale|stale element/i.test(text)) return 'stale'
  return 'error'
}

const structured = (r: Raw): Record<string, unknown> => {
  try {
    const j = JSON.parse(r.rawJson) as { structuredContent?: Record<string, unknown> }
    return j.structuredContent ?? {}
  } catch {
    return {}
  }
}

const toWindow = (w: Record<string, unknown>): DesktopWindow => ({
  id: Number(w.window_id),
  pid: Number(w.pid),
  app: String(w.app_name ?? ''),
  title: String(w.title ?? ''),
  onScreen: w.is_on_screen !== false,
  minimized: w.minimized === true,
  bounds: w.bounds as DesktopWindow['bounds'],
})

/** Rows look like `- [12] Button "Seven" [id=num7Button actions=[invoke]]`. */
export function parseRows(text: string): Map<number, string> {
  const rows = new Map<number, string>()
  for (const line of text.split('\n')) {
    const m = /^\s*- \[(\d+)\] (.*)$/.exec(line)
    if (m) rows.set(Number(m[1]), m[2]!)
  }
  return rows
}

const NAME_AS_TEXT = (s: string) => s.replace(/\s+/g, ' ').trim()

export class CuaDesktopDriver implements DesktopDriver {
  readonly name = 'cua'
  /** The newest snapshot id of each window; the SDK refuses tokens from older ones. */
  private readonly latest = new Map<number, string>()
  private readonly launched = new Set<number>()

  constructor(
    private readonly client: CuaClient,
    /** Runs a PowerShell script (UI Automation lookups); tests stand in for it. */
    private readonly runScript?: RunScript,
  ) {}

  /** Loads the SDK; a driver for hosts where it is installed and the platform is supported. */
  static async load(): Promise<Outcome<{ driver: CuaDesktopDriver }>> {
    // Windows is the tested platform. Linux uses the SDK's AT-SPI and X11 backend, which needs an
    // X11 session (Wayland-only desktops are refused by its health check), and is untested here.
    if (process.platform !== 'win32' && process.platform !== 'linux')
      return {
        ok: false,
        code: 'unavailable',
        error: `Computer use is wired up for Windows and Linux hosts (this host is ${process.platform}).`,
      }
    try {
      // A variable specifier keeps the bundler from pulling the native library into the host.
      const specifier = '@trycua/cua-driver'
      const sdk = (await import(specifier)) as {
        CuaDriver: { create(options: undefined): CuaClient }
      }
      return { ok: true, driver: new CuaDesktopDriver(sdk.CuaDriver.create(undefined)) }
    } catch (err) {
      return {
        ok: false,
        code: 'unavailable',
        error: `The computer-use library (@trycua/cua-driver) could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
      }
    }
  }

  private async tool(name: string, args: Record<string, unknown>): Promise<Raw> {
    return this.client.callTool(name, JSON.stringify(args))
  }

  private fail(r: Raw): { ok: false; code: FailCode; error: string } {
    const error = r.text || 'The driver refused the action'
    return { ok: false, code: failCode(error), error }
  }

  async ready(): Promise<Outcome> {
    const r = await this.tool('check_permissions', {}).catch((e: unknown) => e)
    if (r instanceof Error) return { ok: false, code: 'unavailable', error: r.message }
    const raw = r as Raw
    if (raw.isError) return { ok: false, code: 'unavailable', error: raw.text }
    const s = structured(raw)
    if (s.uia === false)
      return { ok: false, code: 'unavailable', error: 'UI Automation is not available' }
    return { ok: true }
  }

  async windows() {
    const r = await this.tool('list_windows', {})
    if (r.isError) return this.fail(r)
    const list = structured(r).windows
    const windows = Array.isArray(list) ? (list as Record<string, unknown>[]).map(toWindow) : []
    return { ok: true as const, windows }
  }

  async launch(app: string) {
    const r = await this.tool('launch_app', { name: app })
    if (r.isError) return this.fail(r)
    const s = structured(r)
    const pid = Number(s.pid)
    if (!Number.isFinite(pid))
      return {
        ok: false as const,
        code: 'error' as const,
        error: 'The app did not report a process',
      }
    this.launched.add(pid)
    const windows = Array.isArray(s.windows)
      ? (s.windows as Record<string, unknown>[]).map((w) => toWindow({ ...w, pid, app_name: app }))
      : []
    return { ok: true as const, pid, windows }
  }

  async snapshot(window: DesktopWindow) {
    const r = await this.tool('get_window_state', { pid: window.pid, window_id: window.id })
    if (r.isError) return this.fail(r)
    const id = /snapshot_id=(\S+)/.exec(r.text)?.[1]
    if (id) this.latest.set(window.id, id)
    // The header names tokens; agents use plain indexes, so it is not passed on.
    const text = r.text
      .split('\n')
      .filter((l) => !/^window_id=|^element_token for row/.test(l))
      .join('\n')
      .trim()
    const image = r.images[0]
    const s = structured(r)
    const width = Number(s.screenshot_width)
    const height = Number(s.screenshot_height)
    const snapshot: Snapshot = {
      text,
      rows: parseRows(text),
      image: image ? { data: image.dataBase64, mime: image.mimeType } : undefined,
      size: width > 0 && height > 0 ? { width, height } : undefined,
    }
    return { ok: true as const, snapshot }
  }

  async restore(window: DesktopWindow) {
    if (process.platform !== 'win32')
      return {
        ok: false as const,
        code: 'unavailable' as const,
        error: 'Restoring a minimized window without activation is only available on Windows.',
      }
    return restoreMinimizedWindow(window.id)
  }

  async secretRegions(
    window: DesktopWindow,
    picture: { width: number; height: number },
    isSecret: (label: string) => boolean,
  ) {
    const found = await readFields(window.id, this.runScript)
    if (!found.ok) return found
    return { ok: true as const, regions: regionsOf(found, picture, isSecret, window.bounds) }
  }

  private token(window: DesktopWindow, index: number): string | undefined {
    const id = this.latest.get(window.id)
    return id ? `${id}:${index}` : undefined
  }

  private async act(name: string, args: Record<string, unknown>, opts: InputOptions) {
    const r = await this.tool(name, {
      ...args,
      delivery_mode: opts.foreground ? 'foreground' : 'background',
    })
    if (r.isError) return this.fail(r)
    return { ok: true as const, detail: NAME_AS_TEXT(r.text.split('\n')[0] ?? '') }
  }

  async click(
    window: DesktopWindow,
    target: ClickTarget,
    opts: InputOptions & { button?: 'left' | 'right' | 'middle'; count?: number },
  ) {
    const base = {
      pid: window.pid,
      window_id: window.id,
      ...(opts.button && opts.button !== 'left' ? { button: opts.button } : {}),
      ...(opts.count && opts.count > 1 ? { count: opts.count } : {}),
    }
    if ('index' in target) {
      const token = this.token(window, target.index)
      if (!token)
        return {
          ok: false as const,
          code: 'stale' as const,
          error: 'Read the window with computer_snapshot before clicking an element.',
        }
      return this.act('click', { ...base, element_token: token }, opts)
    }
    return this.act('click', { ...base, x: target.x, y: target.y }, opts)
  }

  async type(window: DesktopWindow, text: string, opts: InputOptions & { index?: number }) {
    const token = opts.index === undefined ? undefined : this.token(window, opts.index)
    return this.act(
      'type_text',
      {
        pid: window.pid,
        window_id: window.id,
        text,
        ...(opts.delayMs ? { delay_ms: opts.delayMs } : {}),
        ...(token ? { element_token: token } : {}),
      },
      opts,
    )
  }

  async setValue(window: DesktopWindow, index: number, value: string, opts: InputOptions) {
    const token = this.token(window, index)
    if (!token)
      return {
        ok: false as const,
        code: 'stale' as const,
        error: 'Read the window with computer_snapshot before setting an element.',
      }
    return this.act(
      'set_value',
      { pid: window.pid, window_id: window.id, element_token: token, value },
      opts,
    )
  }

  async key(window: DesktopWindow, keys: string | string[], opts: InputOptions) {
    const base = { pid: window.pid, window_id: window.id }
    if (Array.isArray(keys) && keys.length > 1) return this.act('hotkey', { ...base, keys }, opts)
    return this.act('press_key', { ...base, key: Array.isArray(keys) ? keys[0] : keys }, opts)
  }

  async scroll(
    window: DesktopWindow,
    direction: 'up' | 'down' | 'left' | 'right',
    amount: number,
    opts: InputOptions,
  ) {
    return this.act(
      'scroll',
      { pid: window.pid, window_id: window.id, direction, amount, by: 'line' },
      opts,
    )
  }

  async terminate(pid: number): Promise<Outcome> {
    if (!this.launched.has(pid))
      return { ok: false, code: 'error', error: 'Only apps this driver launched can be ended' }
    const r = await this.tool('kill_app', { pid })
    if (r.isError) return this.fail(r)
    this.launched.delete(pid)
    return { ok: true }
  }

  async dispose() {
    await this.client.shutdown().catch(() => {})
    this.client.uniffiDestroy?.()
  }
}
