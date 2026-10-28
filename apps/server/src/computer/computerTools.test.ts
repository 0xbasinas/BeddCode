import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  COMPUTER_TOOL_DEFINITIONS,
  ComputerTools,
  isComputerToolName,
  redact,
  type ComputerToolName,
  type ComputerToolsHost,
} from './computerTools.ts'
import type {
  ClickTarget,
  DesktopDriver,
  DesktopWindow,
  InputOptions,
  Outcome,
  Snapshot,
} from './driver.ts'

const png = { data: Buffer.from('png').toString('base64'), mime: 'image/png' }

/** A desktop of windows whose rows and behaviour the test sets. */
class FakeDesktop implements DesktopDriver {
  readonly name = 'fake'
  windowsList: DesktopWindow[] = []
  rows = new Map<number, Map<number, string>>()
  /** Pids whose windows refuse everything like an elevated program. */
  elevated = new Set<number>()
  /** Window ids that only take typed input in the foreground. */
  needsForeground = new Set<number>()
  /** Whether typing lands in the row. */
  typingLands = true
  calls: string[] = []
  delays: (number | undefined)[] = []
  active = 0
  maxActive = 0
  nextPid = 1000

  win(id: number, app: string, title: string, pid = id): DesktopWindow {
    const w = { id, pid, app, title, onScreen: true }
    this.windowsList.push(w)
    return w
  }

  private async busy<T>(run: () => T): Promise<T> {
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    await new Promise((r) => setTimeout(r, 2))
    this.active--
    return run()
  }

  private guard(w: DesktopWindow): Outcome | undefined {
    return this.elevated.has(w.pid)
      ? { ok: false, code: 'elevated', error: 'UIPI: target is at High integrity' }
      : undefined
  }

  async ready(): Promise<Outcome> {
    return { ok: true }
  }

  async windows() {
    return { ok: true as const, windows: this.windowsList }
  }

  async launch(app: string) {
    this.calls.push(`launch ${app}`)
    const existing = this.windowsList.find((w) => w.app === app)
    if (existing) return { ok: true as const, pid: existing.pid, windows: [existing] }
    const pid = this.nextPid++
    return { ok: true as const, pid, windows: [this.win(pid + 5000, app, `${app} window`, pid)] }
  }

  async snapshot(w: DesktopWindow) {
    return this.busy(() => {
      const g = this.guard(w)
      if (g && !g.ok) return g
      const rows = new Map(this.rows.get(w.id) ?? [])
      const text = ['- Window "x"', ...[...rows].map(([i, r]) => `  - [${i}] ${r}`)].join('\n')
      const snapshot: Snapshot = { text, rows, image: png }
      return { ok: true as const, snapshot }
    })
  }

  async click(w: DesktopWindow, target: ClickTarget, opts: InputOptions & { count?: number }) {
    return this.busy(() => {
      const g = this.guard(w)
      if (g && !g.ok) return g
      this.calls.push(`click ${JSON.stringify(target)}${opts.foreground ? ' fg' : ''}`)
      return { ok: true as const, detail: 'Clicked' }
    })
  }

  async type(w: DesktopWindow, text: string, opts: InputOptions & { index?: number }) {
    return this.busy(() => {
      const g = this.guard(w)
      if (g && !g.ok) return g
      if (this.needsForeground.has(w.id) && !opts.foreground)
        return {
          ok: false as const,
          code: 'foreground_needed' as const,
          error: 'Background delivery is not available',
        }
      this.delays.push(opts.delayMs)
      this.calls.push(`type ${JSON.stringify(text)}${opts.foreground ? ' fg' : ''}`)
      if (this.typingLands && opts.index !== undefined) {
        const rows = this.rows.get(w.id)!
        rows.set(opts.index, `Edit "Name" [value="${text}"]`)
      }
      return { ok: true as const, detail: `Typed ${text.length} chars` }
    })
  }

  setFails = false

  async setValue(w: DesktopWindow, index: number, value: string) {
    return this.busy(() => {
      const g = this.guard(w)
      if (g && !g.ok) return g
      if (this.setFails)
        return {
          ok: false as const,
          code: 'error' as const,
          error: 'element does not implement ValuePattern',
        }
      this.calls.push(`set ${index} ${JSON.stringify(value)}`)
      this.rows.get(w.id)!.set(index, `Edit "Name" [value="${value}"]`)
      return { ok: true as const, detail: 'Set the value' }
    })
  }

  async key(w: DesktopWindow, keys: string | string[], opts: InputOptions) {
    return this.busy(() => {
      const g = this.guard(w)
      if (g && !g.ok) return g
      this.calls.push(`key ${[keys].flat().join('+')}${opts.foreground ? ' fg' : ''}`)
      return { ok: true as const, detail: 'Sent key' }
    })
  }

  async scroll(w: DesktopWindow, direction: string, amount: number) {
    this.calls.push(`scroll ${direction} ${amount}`)
    return { ok: true as const, detail: 'Scrolled' }
  }

  async terminate(pid: number): Promise<Outcome> {
    this.calls.push(`terminate ${pid}`)
    this.windowsList = this.windowsList.filter((w) => w.pid !== pid)
    return { ok: true }
  }

  async dispose() {}
}

interface Asked {
  title: string
  detail?: string
}

function setup(opts: { level?: number; answer?: (a: Asked) => boolean; maxActions?: number } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'computer-test-'))
  dirs.push(dir)
  const desktop = new FakeDesktop()
  const asked: Asked[] = []
  const host: ComputerToolsHost = {
    currentMode: () => 'default',
    modeLevel: () => opts.level ?? 1,
    describe: async () => ({ agent: 'Claude' }),
    askUser: async (_s, a) => {
      asked.push(a)
      return opts.answer ? opts.answer(a) : true
    },
  }
  const tools = new ComputerTools(async () => ({ ok: true, driver: desktop }), host, dir, {
    maxActions: opts.maxActions ?? 300,
  })
  const call = (tool: ComputerToolName, args: Record<string, unknown> = {}, session = 's1') =>
    tools.call(session, tool, args)
  const text = (r: Awaited<ReturnType<typeof call>>) =>
    r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n')
  return { desktop, asked, tools, call, text, dir }
}

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('tool list', () => {
  it('names every tool once, with an input schema', () => {
    const names = COMPUTER_TOOL_DEFINITIONS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const t of COMPUTER_TOOL_DEFINITIONS) {
      expect(t.inputSchema.type).toBe('object')
      expect(isComputerToolName(t.name)).toBe(true)
    }
    expect(isComputerToolName('browser_click')).toBe(false)
  })
})

describe('launching and ownership', () => {
  it('asks before opening an app, and stops when the user says no', async () => {
    const { call, asked, desktop, text } = setup({ answer: () => false })
    const r = await call('computer_launch', { app: 'calc' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/did not allow opening calc/)
    expect(asked[0]!.title).toBe('Let Claude open calc?')
    expect(desktop.calls).toEqual([])
  })

  it('does not ask at the permission level that allows everything', async () => {
    const { call, asked } = setup({ level: 3 })
    expect((await call('computer_launch', { app: 'calc' })).isError).toBeUndefined()
    expect(asked).toEqual([])
  })

  it('treats an app it opened as its own: no second question', async () => {
    const { call, asked, desktop } = setup()
    const launched = await call('computer_launch', { app: 'calc' })
    expect(launched.isError).toBeUndefined()
    const id = desktop.windowsList[0]!.id
    desktop.rows.set(id, new Map([[1, 'Button "Seven"']]))
    const r = await call('computer_snapshot', { window: id })
    expect(r.isError).toBeUndefined()
    expect(asked.map((a) => a.title)).toEqual(['Let Claude open calc?'])
  })

  it('does not take over an app that was already open: the user is asked first', async () => {
    const { call, asked, desktop, text } = setup()
    const w = desktop.win(7, 'notepad.exe', 'notes - Notepad', 70)
    const launched = await call('computer_launch', { app: 'notepad.exe' })
    expect(text(launched)).toMatch(/already open/)
    desktop.rows.set(7, new Map([[1, 'Edit "Text editor"']]))
    await call('computer_snapshot', { window: w.id })
    expect(asked.map((a) => a.title)).toEqual([
      'Let Claude open notepad.exe?',
      'Let Claude control notepad.exe?',
    ])
  })

  it('asks once per program and session, and not for another session when it said no', async () => {
    const { call, asked, desktop } = setup({ answer: (a) => !/control/.test(a.title) })
    desktop.win(7, 'Mail', 'Inbox')
    expect((await call('computer_snapshot', { window: 7 })).isError).toBe(true)
    expect((await call('computer_snapshot', { window: 7 })).isError).toBe(true)
    expect(asked.filter((a) => /control/.test(a.title))).toHaveLength(2)
  })

  it('remembers a yes for the session, and takes it back on revoke', async () => {
    const { call, asked, desktop, tools } = setup()
    desktop.win(7, 'Mail', 'Inbox')
    desktop.rows.set(7, new Map())
    await call('computer_snapshot', { window: 7 })
    await call('computer_snapshot', { window: 7 })
    expect(asked).toHaveLength(1)
    // Another session has no such yes.
    await call('computer_snapshot', { window: 7 }, 's2')
    expect(asked).toHaveLength(2)
    tools.revoke('s1')
    await call('computer_snapshot', { window: 7 })
    expect(asked).toHaveLength(3)
  })

  it('never lets an agent operate a password manager, and does not even ask', async () => {
    const { call, asked, desktop, text } = setup()
    desktop.win(9, '1Password.exe', '1Password')
    const r = await call('computer_snapshot', { window: 9 })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^blocked/)
    expect(asked).toEqual([])
  })

  it('ends only apps it opened', async () => {
    const { call, desktop, text } = setup({ level: 3 })
    const other = desktop.win(7, 'Mail', 'Inbox')
    await call('computer_snapshot', { window: other.id })
    expect(text(await call('computer_close', { window: other.id }))).toMatch(
      /only end apps you opened/,
    )
    await call('computer_launch', { app: 'calc' })
    const mine = desktop.windowsList.find((w) => w.app === 'calc')!
    expect(text(await call('computer_close', { window: mine.id }))).toMatch(/Ended calc/)
    expect(desktop.calls).toContain(`terminate ${mine.pid}`)
  })
})

describe('reading', () => {
  it('returns the tree, a picture and a saved image path', async () => {
    const { call, desktop, text, dir } = setup({ level: 3 })
    await call('computer_launch', { app: 'calc' })
    const id = desktop.windowsList[0]!.id
    desktop.rows.set(id, new Map([[3, 'Button "Seven" [id=num7Button]']]))
    const r = await call('computer_snapshot', { window: id })
    expect(text(r)).toContain('[3] Button "Seven"')
    expect(r.content.some((c) => c.type === 'image')).toBe(true)
    expect(text(r)).toContain(`image: ${dir}`)
  })

  it('hides the value and the picture of a password field', async () => {
    const { call, desktop, text } = setup({ level: 3 })
    await call('computer_launch', { app: 'login' })
    const id = desktop.windowsList[0]!.id
    desktop.rows.set(
      id,
      new Map([
        [1, 'Edit "Username" [value="alice"]'],
        [2, 'Edit "Password" [value="hunter2hunter2"]'],
      ]),
    )
    const r = await call('computer_snapshot', { window: id })
    expect(text(r)).toContain('value="alice"')
    expect(text(r)).not.toContain('hunter2')
    expect(text(r)).toContain('value="(hidden)"')
    expect(r.content.some((c) => c.type === 'image')).toBe(false)
    const shot = await call('computer_screenshot', { window: id })
    expect(shot.content.some((c) => c.type === 'image')).toBe(false)
  })

  it('redact keeps ordinary values and hides the value of secret-looking fields', () => {
    const tree = ['Edit "Name" [value="bob"]', 'Edit "API key" [value="sk-live-abcdef"]'].join('\n')
    expect(redact(tree)).toBe(
      ['Edit "Name" [value="bob"]', 'Edit "API key" [value="(hidden)"]'].join('\n'),
    )
  })

  it('explains elevated windows instead of failing quietly', async () => {
    const { call, desktop, text } = setup({ level: 3 })
    await call('computer_launch', { app: 'admin-shell' })
    const w = desktop.windowsList[0]!
    desktop.elevated.add(w.pid)
    const r = await call('computer_snapshot', { window: w.id })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/^blocked: .*administrator/)
  })

  it('says when a window id is wrong', async () => {
    const { call, text } = setup()
    expect(text(await call('computer_snapshot', { window: 99 }))).toMatch(/No window 99/)
    expect(text(await call('computer_snapshot', { window: 'x' }))).toMatch(/must be a window id/)
  })

  it('lists windows without private details beyond the title', async () => {
    const { call, desktop, text } = setup()
    desktop.win(1, 'Mail', 'Inbox')
    desktop.windowsList.push({ id: 2, pid: 2, app: 'Hidden', title: 'x', onScreen: false })
    const out = text(await call('computer_windows'))
    expect(out).toContain('1\tMail\t"Inbox"')
    expect(out).not.toContain('Hidden')
  })
})

describe('acting', () => {
  async function calc() {
    const s = setup({ level: 3 })
    await s.call('computer_launch', { app: 'calc' })
    const id = s.desktop.windowsList[0]!.id
    s.desktop.rows.set(
      id,
      new Map([
        [1, 'Button "Seven"'],
        [2, 'Edit "Name" [value=""]'],
      ]),
    )
    return { ...s, id }
  }

  it('wants a snapshot before a ref is used', async () => {
    const { call, id, text } = await calc()
    expect(text(await call('computer_click', { window: id, ref: 'e1' }))).toMatch(
      /Call computer_snapshot first/,
    )
  })

  it('clicks an element it has read', async () => {
    const { call, id, desktop, text } = await calc()
    await call('computer_snapshot', { window: id })
    const r = await call('computer_click', { window: id, ref: 'e1' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toMatch(/new computer_snapshot/)
    expect(desktop.calls).toContain('click {"index":1}')
  })

  it('refuses a ref whose element changed, so it never clicks the wrong thing', async () => {
    const { call, id, desktop, text } = await calc()
    await call('computer_snapshot', { window: id })
    desktop.rows.get(id)!.set(1, 'Button "Delete everything"')
    const r = await call('computer_click', { window: id, ref: 'e1' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/stale/)
    expect(desktop.calls.some((c) => c.startsWith('click'))).toBe(false)
  })

  it('clicks at coordinates with no snapshot, and needs a ref or coordinates', async () => {
    const { call, id, desktop, text } = await calc()
    await call('computer_click', { window: id, x: 10, y: 20, double: true })
    expect(desktop.calls).toContain('click {"x":10,"y":20}')
    expect(text(await call('computer_click', { window: id }))).toMatch(/ref, or x and y/)
  })

  it('falls back to the foreground for typing when the window needs it, and says so', async () => {
    const { call, id, desktop, text } = await calc()
    desktop.needsForeground.add(id)
    await call('computer_snapshot', { window: id })
    const r = await call('computer_type', { window: id, text: 'hello', ref: 'e2' })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toMatch(/foreground/)
    expect(text(r)).toMatch(/Verified/)
    expect(desktop.calls).toContain('type "hello" fg')
  })

  it('types with a pause between characters, so slow apps do not garble the text', async () => {
    const { call, id, desktop } = await calc()
    await call('computer_type', { window: id, text: 'hello' })
    expect(desktop.delays).toEqual([25])
  })

  it('replaces a field directly with clear, and reads it back', async () => {
    const { call, id, desktop, text } = await calc()
    await call('computer_snapshot', { window: id })
    const r = await call('computer_type', {
      window: id,
      text: 'whole text',
      ref: 'e2',
      clear: true,
    })
    expect(r.isError).toBeUndefined()
    expect(text(r)).toMatch(/Verified/)
    expect(desktop.calls).toContain('set 2 "whole text"')
    expect(desktop.calls.some((c) => c.startsWith('type'))).toBe(false)
  })

  it('needs a ref for clear, and says when the element cannot be set directly', async () => {
    const { call, id, desktop, text } = await calc()
    expect(text(await call('computer_type', { window: id, text: 'x', clear: true }))).toMatch(
      /give its ref/,
    )
    await call('computer_snapshot', { window: id })
    desktop.setFails = true
    const r = await call('computer_type', { window: id, text: 'x', ref: 'e2', clear: true })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/type into it instead/)
  })

  it('still asks before setting a secret field directly', async () => {
    const s = setup({ level: 3, answer: () => false })
    await s.call('computer_launch', { app: 'login' })
    const id = s.desktop.windowsList[0]!.id
    s.desktop.rows.set(id, new Map([[4, 'Edit "Password" [value=""]']]))
    await s.call('computer_snapshot', { window: id })
    const r = await s.call('computer_type', { window: id, text: 'abc', ref: 'e4', clear: true })
    expect(r.isError).toBe(true)
    expect(s.desktop.calls.some((c) => c.startsWith('set'))).toBe(false)
  })

  it('does not take the foreground when told never to', async () => {
    const { call, id, desktop, text } = await calc()
    desktop.needsForeground.add(id)
    const r = await call('computer_type', { window: id, text: 'hello', foreground: 'never' })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/only takes input in the foreground/)
    expect(desktop.calls.some((c) => c.startsWith('type'))).toBe(false)
  })

  it('reports typing that did not land as not verified', async () => {
    const { call, id, desktop, text } = await calc()
    desktop.typingLands = false
    await call('computer_snapshot', { window: id })
    const r = await call('computer_type', { window: id, text: 'hello', ref: 'e2' })
    expect(text(r)).toMatch(/NOT verified/)
  })

  it('does not claim to verify typing it cannot read back', async () => {
    const { call, id, text } = await calc()
    const r = await call('computer_type', { window: id, text: 'hello' })
    expect(text(r)).toMatch(/Not verified/)
  })

  it('asks before typing into a password field and passes the answer on', async () => {
    const s = setup({ level: 3, answer: () => false })
    await s.call('computer_launch', { app: 'login' })
    const id = s.desktop.windowsList[0]!.id
    s.desktop.rows.set(id, new Map([[4, 'Edit "Password" [value=""]']]))
    await s.call('computer_snapshot', { window: id })
    const r = await s.call('computer_type', { window: id, text: 'abc', ref: 'e4' })
    expect(r.isError).toBe(true)
    expect(s.text(r)).toMatch(/did not allow typing a secret/)
    expect(s.asked.at(-1)!.title).toMatch(/password or secret/)
    expect(s.desktop.calls.some((c) => c.startsWith('type'))).toBe(false)
  })

  it('asks before typing something that looks like a key, and types it when allowed', async () => {
    const { call, id, asked, desktop } = await calc()
    await call('computer_type', { window: id, text: 'ghp_abcdefghijklmnopqrstuvwxyz0123' })
    expect(asked.some((a) => /secret/.test(a.title))).toBe(true)
    expect(desktop.calls.some((c) => c.startsWith('type'))).toBe(true)
  })

  it('asks before system key combinations, not ordinary ones', async () => {
    const { call, id, asked, desktop } = await calc()
    await call('computer_key', { window: id, keys: 'ctrl+s' })
    expect(asked.filter((a) => /press/.test(a.title))).toEqual([])
    await call('computer_key', { window: id, keys: 'alt+F4' })
    await call('computer_key', { window: id, keys: 'win+r' })
    expect(asked.filter((a) => /press/.test(a.title)).map((a) => a.title)).toEqual([
      'Let Claude press alt+F4?',
      'Let Claude press win+r?',
    ])
    expect(desktop.calls).toContain('key ctrl+s')
    expect(desktop.calls).toContain('key alt+f4')
  })

  it('stops a session that uses up its actions', async () => {
    const { call, id, text } = await (async () => {
      const s = setup({ level: 3, maxActions: 2 })
      await s.call('computer_launch', { app: 'calc' })
      return { ...s, id: s.desktop.windowsList[0]!.id }
    })()
    expect((await call('computer_key', { window: id, keys: 'a' })).isError).toBeUndefined()
    expect((await call('computer_key', { window: id, keys: 'b' })).isError).toBeUndefined()
    const r = await call('computer_key', { window: id, keys: 'c' })
    expect(text(r)).toMatch(/used its 2 computer actions/)
  })

  it('runs calls one at a time: there is one mouse and one keyboard', async () => {
    const { call, id, desktop } = await calc()
    await Promise.all([
      call('computer_key', { window: id, keys: 'a' }),
      call('computer_key', { window: id, keys: 'b' }),
      call('computer_click', { window: id, x: 1, y: 1 }),
      call('computer_snapshot', { window: id }),
    ])
    expect(desktop.maxActive).toBe(1)
  })

  it('limits scroll amounts and checks direction', async () => {
    const { call, id, desktop, text } = await calc()
    await call('computer_scroll', { window: id, direction: 'down', amount: 9999 })
    expect(desktop.calls).toContain('scroll down 50')
    expect(text(await call('computer_scroll', { window: id, direction: 'sideways' }))).toMatch(
      /direction/,
    )
  })

  it('rejects an empty or huge text', async () => {
    const { call, id } = await calc()
    expect((await call('computer_type', { window: id, text: '' })).isError).toBe(true)
    expect((await call('computer_type', { window: id, text: 'x'.repeat(5001) })).isError).toBe(true)
  })
})

describe('unavailable driver', () => {
  it('tells the agent why and tries again next time', async () => {
    let tries = 0
    const tools = new ComputerTools(
      async () => {
        tries++
        return { ok: false, code: 'unavailable', error: 'Only wired up for Windows hosts' }
      },
      {
        currentMode: () => undefined,
        modeLevel: () => 1,
        describe: async () => ({ agent: 'x' }),
        askUser: async () => true,
      },
      os.tmpdir(),
    )
    const r = await tools.call('s', 'computer_windows', {})
    expect(r.isError).toBe(true)
    expect(JSON.stringify(r)).toMatch(/Windows hosts/)
    await tools.call('s', 'computer_windows', {})
    expect(tries).toBe(2)
  })
})
