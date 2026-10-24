import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { BrowserUseResult, ServerFrame } from '@beddcode/contracts'
import { BrowserBroker, BrowserTools, type BrowserToolsHost } from './browserUse.ts'

type Call = Extract<ServerFrame, { t: 'browser.call' }>

/** A connected app: records the calls it gets and answers them when told. */
function app(
  broker: BrowserBroker,
  offer: {
    available: boolean
    reason?: 'web' | 'mobile'
    focus?: { sessionId: string; at: number }
  },
) {
  const calls: Call[] = []
  const conn = broker.connect((f) => {
    if (f.t === 'browser.call') calls.push(f)
  })
  conn.frame({ t: 'browser.offer', ...offer })
  const answer = (result: BrowserUseResult, i = calls.length - 1) =>
    conn.frame({ t: 'browser.result', id: calls[i]!.id, result })
  return { calls, conn, answer }
}

const call = (sessionId = 's1') => ({
  sessionId,
  tool: 'browser_snapshot' as const,
  args: {},
  agent: 'Claude',
})
const tick = () => new Promise((r) => setTimeout(r, 0))

describe('BrowserBroker', () => {
  it('explains when there is no desktop app', async () => {
    const broker = new BrowserBroker()
    expect(await broker.call(call())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/No BeddCode desktop app/),
    })
    app(broker, { available: false, reason: 'web' })
    expect(await broker.call(call())).toMatchObject({
      ok: false,
      error: expect.stringMatching(/web or phone app/),
    })
  })

  it('prefers the app showing the session, then the one looked at last, and sticks to it', async () => {
    const broker = new BrowserBroker()
    const a = app(broker, { available: true, focus: { sessionId: 's1', at: 1 } })
    const b = app(broker, { available: true, focus: { sessionId: 'other', at: 5 } })
    expect(broker.size).toBe(2)
    const one = broker.call(call('s1'))
    expect(a.calls).toHaveLength(1)
    a.answer({ ok: true, text: 'done' })
    expect(await one).toEqual({ ok: true, text: 'done' })
    // s2 is shown nowhere: the most recently focused app (b) runs it.
    void broker.call(call('s2'))
    expect(b.calls).toHaveLength(1)
    // Focus moves, but s2 keeps its app (its tabs live there).
    a.conn.frame({ t: 'browser.offer', available: true, focus: { sessionId: 's2', at: 9 } })
    void broker.call(call('s2'))
    expect(b.calls).toHaveLength(2)
  })

  it('ignores answers from another app and fails calls when their app goes', async () => {
    const broker = new BrowserBroker()
    const a = app(broker, { available: true })
    const b = app(broker, { available: true, focus: { sessionId: 'x', at: 1 } })
    const pending = broker.call(call())
    const target = a.calls.length ? a : b
    const other = target === a ? b : a
    other.conn.frame({
      t: 'browser.result',
      id: target.calls[0]!.id,
      result: { ok: true, text: 'forged' },
    })
    target.conn.close()
    expect(await pending).toMatchObject({ ok: false, error: expect.stringMatching(/disconnected/) })
  })

  it('times out', async () => {
    const broker = new BrowserBroker()
    app(broker, { available: true })
    expect(await broker.call(call(), 10)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/did not answer/),
    })
  })
})

describe('BrowserTools', () => {
  let dir: string | undefined
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  const setup = (mode: string, answers: boolean[] = []) => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'bc-browser-'))
    const asked: string[] = []
    const host: BrowserToolsHost = {
      currentMode: () => mode,
      describe: async () => ({ agent: 'Claude', title: 'Checkout test' }),
      askUser: async (_s, ask) => {
        asked.push(ask.title)
        return answers.shift() ?? false
      },
      modeLevel: (m) => ({ default: 1, acceptEdits: 2, bypassPermissions: 3 })[m] ?? 1,
    }
    const broker = new BrowserBroker()
    const a = app(broker, { available: true })
    return { tools: new BrowserTools(broker, host, dir), a, asked }
  }

  it('asks before running a script unless the session has full access', async () => {
    const { tools, a, asked } = setup('default', [false])
    const r = await tools.call('s1', 'browser_evaluate', { script: 'document.title' })
    expect(r.isError).toBe(true)
    expect(asked).toEqual(['Let Claude run JavaScript in the browser?'])
    expect(a.calls).toHaveLength(0)

    const full = setup('bypassPermissions')
    const p = full.tools.call('s1', 'browser_evaluate', { script: '1' })
    await tick()
    expect(full.asked).toEqual([])
    expect(full.a.calls[0]!.call).toMatchObject({ tool: 'browser_evaluate', confirmSubmits: false })
    full.a.answer({ ok: true, text: '1' })
    expect((await p).content).toEqual([{ type: 'text', text: '1' }])
  })

  it('asks the user when the app needs approval, then calls again approved', async () => {
    const { tools, a, asked } = setup('default', [true])
    const p = tools.call('s1', 'browser_click', { ref: 'e4' })
    await tick()
    expect(a.calls[0]!.call).toMatchObject({
      confirmSubmits: true,
      agent: 'Claude',
      sessionTitle: 'Checkout test',
    })
    a.answer({ ok: false, needsApproval: { title: 'Let Claude send a form on shop.example?' } })
    await tick()
    await tick()
    expect(asked).toEqual(['Let Claude send a form on shop.example?'])
    expect(a.calls[1]!.call).toMatchObject({ approved: true })
    a.answer({ ok: true, text: 'Clicked button "Pay".' })
    expect((await p).isError).toBeUndefined()
  })

  it('keeps pictures for the cards and gives screenshots to the agent', async () => {
    const { tools, a } = setup('default')
    const png = Buffer.from('fake-png').toString('base64')
    const p = tools.call('s1', 'browser_screenshot', {})
    await tick()
    a.answer({
      ok: true,
      text: 'Page: Checkout — http://localhost/',
      image: { data: png, mime: 'image/png' },
    })
    const r = await p
    const text = (r.content[0] as { text: string }).text
    const file = /^image: (.+)$/m.exec(text)![1]!
    expect(file.endsWith('.png')).toBe(true)
    expect(readFileSync(file, 'utf8')).toBe('fake-png')
    expect(r.content[1]).toEqual({ type: 'image', data: png, mimeType: 'image/png' })
  })
})
