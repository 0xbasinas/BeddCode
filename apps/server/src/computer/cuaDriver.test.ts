import { describe, expect, it } from 'vitest'
import { CuaDesktopDriver, failCode, parseRows, type CuaClient } from './cuaDriver.ts'

const STATE = `window_id=5 pid=9 elements=3 snapshot_id=s00000007
element_token for row [N] = s00000007:N (row [1] is "s00000007:1")

- Window "Calculator"
  - [0] Window "Calculator" [value="Calculator" id=TitleBar actions=[set_value]]
    - [1] Button "Seven" [id=num7Button actions=[invoke]]
      - [2] Edit "Name box" [value="a \\"quoted\\" value" actions=[set_value]]`

interface Call {
  name: string
  args: Record<string, unknown>
}

/** Stands in for the native library: answers by tool name and records what it was asked. */
function client(answers: Record<string, unknown>) {
  const calls: Call[] = []
  const c: CuaClient = {
    async callTool(name, json) {
      calls.push({ name, args: JSON.parse(json) })
      const a = (answers[name] ?? { text: '' }) as {
        text?: string
        isError?: boolean
        structured?: unknown
        images?: { mimeType: string; dataBase64: string }[]
      }
      return {
        text: a.text ?? '',
        isError: a.isError ?? false,
        images: a.images ?? [],
        rawJson: JSON.stringify({ structuredContent: a.structured }),
      }
    },
    async shutdown() {},
  }
  return { c, calls }
}

const win = { id: 5, pid: 9, app: 'calc', title: 'Calculator', onScreen: true }

describe('failCode', () => {
  it('recognises what an agent can act on', () => {
    expect(failCode('UIPI: target hwnd 0x1 is at High integrity')).toBe('elevated')
    expect(failCode('Background delivery is not available for target window class X')).toBe(
      'foreground_needed',
    )
    expect(failCode('element_token is stale; call get_window_state again')).toBe('stale')
    expect(failCode('something else')).toBe('error')
  })
})

describe('parseRows', () => {
  it('reads indexed rows at any depth and skips unindexed ones', () => {
    const rows = parseRows(STATE)
    expect([...rows.keys()]).toEqual([0, 1, 2])
    expect(rows.get(1)).toBe('Button "Seven" [id=num7Button actions=[invoke]]')
    expect(rows.get(2)).toContain('value="a \\"quoted\\" value"')
  })
})

describe('CuaDesktopDriver', () => {
  it('lists windows from the structured result', async () => {
    const { c } = client({
      list_windows: {
        structured: {
          windows: [
            { window_id: 5, pid: 9, app_name: 'calc.exe', title: 'Calculator', is_on_screen: true },
            {
              window_id: 6,
              pid: 10,
              app_name: 'x',
              title: '',
              is_on_screen: false,
              minimized: true,
            },
          ],
        },
      },
    })
    const r = await new CuaDesktopDriver(c).windows()
    expect(r).toMatchObject({
      ok: true,
      windows: [
        { id: 5, pid: 9, app: 'calc.exe', title: 'Calculator', onScreen: true },
        { id: 6, onScreen: false, minimized: true },
      ],
    })
  })

  it('reads a window without the token header, and keeps its snapshot id for clicks', async () => {
    const { c, calls } = client({
      get_window_state: {
        text: STATE,
        images: [{ mimeType: 'image/png', dataBase64: 'AAAA' }],
      },
      click: { text: '✅ Performed UIA Invoke on [1]' },
    })
    const d = new CuaDesktopDriver(c)
    const s = await d.snapshot(win)
    expect(s.ok && s.snapshot.text).not.toMatch(/snapshot_id|element_token/)
    expect(s.ok && s.snapshot.image).toEqual({ data: 'AAAA', mime: 'image/png' })
    const r = await d.click(win, { index: 1 }, {})
    expect(r).toEqual({ ok: true, detail: '✅ Performed UIA Invoke on [1]' })
    expect(calls.at(-1)).toEqual({
      name: 'click',
      args: {
        pid: 9,
        window_id: 5,
        element_token: 's00000007:1',
        delivery_mode: 'background',
      },
    })
  })

  it('will not click an element before the window was read', async () => {
    const { c, calls } = client({})
    const r = await new CuaDesktopDriver(c).click(win, { index: 1 }, {})
    expect(r).toMatchObject({ ok: false, code: 'stale' })
    expect(calls).toEqual([])
  })

  it('sends coordinates, buttons and counts, and the foreground when asked', async () => {
    const { c, calls } = client({ click: { text: 'ok' } })
    await new CuaDesktopDriver(c).click(
      win,
      { x: 3, y: 4 },
      { button: 'right', count: 2, foreground: true },
    )
    expect(calls[0]!.args).toEqual({
      pid: 9,
      window_id: 5,
      x: 3,
      y: 4,
      button: 'right',
      count: 2,
      delivery_mode: 'foreground',
    })
  })

  it('maps refusals to codes', async () => {
    const { c } = client({
      type_text: {
        isError: true,
        text: 'Background delivery is not available for target window class Chrome_WidgetWin_1',
      },
      press_key: { isError: true, text: 'UIPI: target hwnd is at High integrity' },
    })
    const d = new CuaDesktopDriver(c)
    expect(await d.type(win, 'x', {})).toMatchObject({ ok: false, code: 'foreground_needed' })
    expect(await d.key(win, 'enter', {})).toMatchObject({ ok: false, code: 'elevated' })
  })

  it('passes the pause between typed characters on', async () => {
    const { c, calls } = client({ type_text: { text: 'ok' } })
    await new CuaDesktopDriver(c).type(win, 'hello', { foreground: true, delayMs: 25 })
    expect(calls[0]!.args).toMatchObject({
      text: 'hello',
      delay_ms: 25,
      delivery_mode: 'foreground',
    })
    await new CuaDesktopDriver(c).type(win, 'x', {})
    expect(calls[1]!.args).not.toHaveProperty('delay_ms')
  })

  it('sets a value on an element it has read, and not before', async () => {
    const { c, calls } = client({ get_window_state: { text: STATE }, set_value: { text: 'ok' } })
    const d = new CuaDesktopDriver(c)
    expect(await d.setValue(win, 2, 'x', {})).toMatchObject({ ok: false, code: 'stale' })
    await d.snapshot(win)
    expect(await d.setValue(win, 2, 'x', {})).toMatchObject({ ok: true })
    expect(calls.at(-1)!.args).toMatchObject({ element_token: 's00000007:2', value: 'x' })
  })

  it('uses hotkey for combinations and press_key for a single key', async () => {
    const { c, calls } = client({ hotkey: { text: 'ok' }, press_key: { text: 'ok' } })
    const d = new CuaDesktopDriver(c)
    await d.key(win, ['ctrl', 's'], {})
    await d.key(win, 'enter', {})
    expect(calls.map((x) => x.name)).toEqual(['hotkey', 'press_key'])
    expect(calls[0]!.args).toMatchObject({ keys: ['ctrl', 's'] })
    expect(calls[1]!.args).toMatchObject({ key: 'enter' })
  })

  it('launches an app and only ends processes it launched', async () => {
    const { c, calls } = client({
      launch_app: {
        text: 'Launched',
        structured: {
          pid: 9,
          windows: [{ window_id: 5, title: 'Calculator', is_on_screen: true }],
        },
      },
      kill_app: { text: 'ok' },
    })
    const d = new CuaDesktopDriver(c)
    expect(await d.terminate(1)).toMatchObject({ ok: false })
    const r = await d.launch('calc')
    expect(r).toMatchObject({ ok: true, pid: 9, windows: [{ id: 5, pid: 9, app: 'calc' }] })
    expect(await d.terminate(9)).toEqual({ ok: true })
    expect(calls.map((x) => x.name)).toEqual(['launch_app', 'kill_app'])
    expect(await d.terminate(9)).toMatchObject({ ok: false })
  })

  it('reports an unusable library as unavailable', async () => {
    const { c } = client({ check_permissions: { structured: { uia: false } } })
    expect(await new CuaDesktopDriver(c).ready()).toMatchObject({ ok: false, code: 'unavailable' })
    const good = client({ check_permissions: { structured: { uia: true } } }).c
    expect(await new CuaDesktopDriver(good).ready()).toEqual({ ok: true })
  })
})
