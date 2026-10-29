import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { ComputerTools, type ComputerToolName } from './computerTools.ts'
import { CuaDesktopDriver } from './cuaDriver.ts'

// Drives the real Windows desktop through Cua: opens Calculator, which it then closes. Off unless
// BEDDCODE_REAL_COMPUTER=1 (it moves things on the screen of whoever runs it).
const on = process.platform === 'win32' && process.env.BEDDCODE_REAL_COMPUTER === '1'

describe.skipIf(!on)('computer tools on the real desktop (Calculator)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'computer-real-'))
  const asked: string[] = []
  const tools = new ComputerTools(
    () => CuaDesktopDriver.load(),
    {
      currentMode: () => 'default',
      modeLevel: () => 1,
      describe: async () => ({ agent: 'Claude' }),
      askUser: async (_s, a) => {
        asked.push(a.title)
        return true
      },
    },
    dir,
  )
  const text = (r: Awaited<ReturnType<typeof tools.call>>) =>
    r.content.map((c) => (c.type === 'text' ? c.text : '[image]')).join('\n')
  const call = (tool: ComputerToolName, args: Record<string, unknown> = {}) =>
    tools.call('real', tool, args)
  let windowId = 0

  afterAll(async () => {
    if (windowId) await call('computer_close', { window: windowId })
    tools.revoke('real')
    await tools.dispose()
    rmSync(dir, { recursive: true, force: true })
  })

  const ref = (tree: string, name: string) => {
    const m = new RegExp(`\\[(\\d+)\\] Button "${name}"`).exec(tree)
    if (!m) throw new Error(`no button ${name} in the tree`)
    return `e${m[1]}`
  }

  it('opens Calculator after asking, and reads it', async () => {
    const r = await call('computer_launch', { app: 'calc' })
    expect(r.isError).toBeUndefined()
    expect(asked).toEqual(['Let Claude open calc?'])
    windowId = Number(/^(\d+)\t/m.exec(text(r))![1])
    await new Promise((r) => setTimeout(r, 1500))
    const s = await call('computer_snapshot', { window: windowId })
    expect(text(s)).toContain('Button "Seven"')
    expect(s.content.some((c) => c.type === 'image')).toBe(true)
  }, 30_000)

  it('calculates 7 × 6 by clicking elements in the background', async () => {
    for (const name of ['Seven', 'Multiply by', 'Six', 'Equals']) {
      const tree = text(await call('computer_snapshot', { window: windowId }))
      const r = await call('computer_click', { window: windowId, ref: ref(tree, name) })
      expect(r.isError, text(r)).toBeUndefined()
    }
    const after = text(await call('computer_snapshot', { window: windowId }))
    expect(after).toContain('Display is 42')
  }, 30_000)

  it('refuses a ref after the window changed under it', async () => {
    const tree = text(await call('computer_snapshot', { window: windowId }))
    // The agent's picture is of the display now; the display changes, and so does the row at "Display".
    await call('computer_click', { window: windowId, ref: ref(tree, 'Seven') })
    const display = /\[(\d+)\] Text "Display is [^"]*"/.exec(tree)![1]
    const r = await call('computer_click', { window: windowId, ref: `e${display}` })
    expect(r.isError).toBe(true)
    expect(text(r)).toMatch(/stale/)
  }, 30_000)

  it('types digits after clearing, checks the result, and reports a send it could not verify', async () => {
    const tree = text(await call('computer_snapshot', { window: windowId }))
    await call('computer_click', { window: windowId, ref: ref(tree, 'Clear entry') })
    // Typing in the background lands in some windows and not in others (it did not in this one
    // once it had been clicked), so the foreground is asked for here and the result is read back.
    const r = await call('computer_type', { window: windowId, text: '8*9=', foreground: 'always' })
    expect(r.isError, text(r)).toBeUndefined()
    expect(text(r)).toMatch(/Not verified/)
    const after = text(await call('computer_snapshot', { window: windowId }))
    expect(after).toContain('Display is 72')
  }, 30_000)

  it('lists windows, and never lets a session end an app it did not open', async () => {
    const list = text(await call('computer_windows'))
    expect(list).toContain('Calculator')
    const other = /^(\d+)\t(?!calc)/m.exec(list)
    if (other) {
      const r = await call('computer_close', { window: Number(other[1]) })
      expect(r.isError).toBe(true)
    }
  }, 30_000)
})
