import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_ALERT_EVENTS, type SessionEvent, type StoredEvent } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import { AlertService, EXPO_PUSH_URL } from './alerts.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function setup(
  response: (body: unknown) => unknown = (b) => ({
    data: (b as unknown[]).map(() => ({ status: 'ok' })),
  }),
) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-alerts-'))
  dirs.push(dir)
  const logs = new Map<string, StoredEvent[]>()
  let seq = 0
  const append = (event: SessionEvent): StoredEvent => {
    const stored = { seq: ++seq, event }
    logs.set(event.sessionId, [...(logs.get(event.sessionId) ?? []), stored])
    return stored
  }
  const sent: { url: string; body: unknown }[] = []
  let now = 1_000_000
  const scheduled = new Set<string>()
  const make = () =>
    new AlertService({
      file: path.join(dir, 'alerts.json'),
      log: createLogger('test', 'error'),
      hostId: 'h1',
      readSession: (id) => logs.get(id) ?? [],
      scheduledTurn: (id) => scheduled.has(id),
      now: () => now,
      fetch: async (url, init) => {
        const body = JSON.parse(init.body) as unknown
        sent.push({ url, body })
        return { ok: true, status: 200, json: async () => response(body) }
      },
    })
  append({
    type: 'session.created',
    sessionId: 's1',
    at: 0,
    title: 'Fix login',
    cwd: '/w',
    instanceId: 'claude',
  })
  return { make, append, sent, scheduled, advance: (ms: number) => (now += ms) }
}

const flush = () => new Promise((r) => setTimeout(r, 5))
const TOKEN = 'ExponentPushToken[abcdefghijklmnop]'

describe('AlertService', () => {
  it('pushes a finished turn with its reply and a link to the session', async () => {
    const t = setup()
    const alerts = t.make()
    alerts.register('dev1', {
      token: TOKEN,
      deviceName: 'Pixel',
      platform: 'android',
      events: DEFAULT_ALERT_EVENTS,
    })
    t.append({
      type: 'message.delta',
      sessionId: 's1',
      at: 0,
      role: 'assistant',
      text: 'Fixed the redirect.',
    })
    alerts.onEvent(t.append({ type: 'turn.completed', sessionId: 's1', at: 0, reason: 'done' }))
    await flush()
    expect(t.sent).toEqual([
      {
        url: EXPO_PUSH_URL,
        body: [
          expect.objectContaining({
            to: TOKEN,
            title: 'Fix login',
            body: 'Fixed the redirect.',
            data: { kind: 'turnDone', sessionId: 's1', hostId: 'h1', url: 'beddcode://session/s1' },
          }),
        ],
      },
    ])
    expect(alerts.view().recent[0]).toMatchObject({
      kind: 'turnDone',
      deliveries: [{ to: 'expo:Pixel', ok: true }],
    })
    expect(alerts.view().devices[0]).toMatchObject({ deviceId: 'dev1', tokenTail: 'klmnop' })
    expect(JSON.stringify(alerts.view())).not.toContain(TOKEN)
  })

  it('follows each phone’s choices and stays quiet for cancelled, child and scheduled turns', async () => {
    const t = setup()
    const alerts = t.make()
    alerts.register('dev1', { token: TOKEN, events: { ...DEFAULT_ALERT_EVENTS, turnDone: false } })
    alerts.onEvent(t.append({ type: 'turn.completed', sessionId: 's1', at: 0, reason: 'done' }))
    alerts.onEvent(
      t.append({ type: 'turn.completed', sessionId: 's1', at: 0, reason: 'cancelled' }),
    )
    await flush()
    expect(t.sent).toHaveLength(0)

    alerts.onEvent(
      t.append({
        type: 'approval.requested',
        sessionId: 's1',
        at: 0,
        requestId: 'r',
        title: 'Run rm -rf build',
        options: [],
      }),
    )
    await flush()
    expect(t.sent).toHaveLength(1)
    expect((t.sent[0]!.body as { body: string }[])[0]!.body).toBe(
      'Needs your approval: Run rm -rf build',
    )

    alerts.register('dev1', { token: TOKEN, events: DEFAULT_ALERT_EVENTS })
    t.append({
      type: 'session.created',
      sessionId: 'child',
      at: 0,
      title: 'Child',
      cwd: '/w',
      instanceId: 'codex',
      parent: { sessionId: 's1', depth: 1 },
    })
    alerts.onEvent(t.append({ type: 'turn.completed', sessionId: 'child', at: 0, reason: 'done' }))
    t.scheduled.add('s1')
    t.advance(10_000)
    alerts.onEvent(t.append({ type: 'turn.completed', sessionId: 's1', at: 0, reason: 'done' }))
    await flush()
    expect(t.sent).toHaveLength(1)
  })

  it('forgets a revoked device and a token Expo no longer knows', async () => {
    const t = setup(() => ({
      data: [{ status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }],
    }))
    const alerts = t.make()
    alerts.register('dev1', { token: TOKEN, events: DEFAULT_ALERT_EVENTS })
    alerts.register('dev2', {
      token: 'ExponentPushToken[second-device]',
      events: DEFAULT_ALERT_EVENTS,
    })
    alerts.forgetDevice('dev2')
    expect(alerts.view().devices).toHaveLength(1)
    const result = await alerts.test()
    expect(result.deliveries[0]).toMatchObject({ ok: false, error: 'gone' })
    expect(alerts.view().devices).toHaveLength(0)
    // Survives a restart.
    expect(t.make().view().devices).toHaveLength(0)
  })

  it('posts to an ntfy topic with a tap-through link', async () => {
    const t = setup()
    const alerts = t.make()
    alerts.setSettings({ ntfyUrl: 'https://ntfy.sh/my-beddcode' })
    alerts.onRunEnded(
      { id: 'r', scheduleId: 'x', startedAt: 0, status: 'done', sessionId: 's1' },
      {
        id: 'x',
        name: 'Nightly',
        prompt: 'p',
        paused: false,
        createdAt: 0,
        trigger: { kind: 'every', minutes: 5 },
        target: { kind: 'session', sessionId: 's1' },
      },
    )
    await flush()
    expect(t.sent).toEqual([
      {
        url: 'https://ntfy.sh/',
        body: expect.objectContaining({
          topic: 'my-beddcode',
          title: 'Scheduled: Nightly',
          click: 'beddcode://session/s1',
        }),
      },
    ])
    expect(alerts.setSettings({ ntfyUrl: null }).ntfyUrl).toBeUndefined()
  })
})
