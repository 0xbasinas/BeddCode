import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, StoredEvent } from '@beddcode/contracts'
import { createLogger } from '@beddcode/shared'
import { TelegramBridge } from './bridge.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-telegram-'))
  dirs.push(dir)
  const logs = new Map<string, StoredEvent[]>()
  let seq = 0
  const append = (event: SessionEvent): StoredEvent => {
    const stored = { seq: ++seq, event }
    logs.set(event.sessionId, [...(logs.get(event.sessionId) ?? []), stored])
    return stored
  }
  const sent: {
    chat: number
    text: string
    buttons?: { text: string; callback_data: string }[][]
  }[] = []
  const prompts: [string, string][] = []
  const deleted: number[] = []
  const approvals: string[][] = []
  const created: { cwd: string; title?: string; model?: string; effort?: string }[] = []
  const fetch = async (url: string, init?: { body?: string }) => {
    const method = url.split('/').pop()
    const body = JSON.parse(init?.body ?? '{}')
    if (method === 'deleteMessages') deleted.push(...body.message_ids)
    if (method === 'sendMessage')
      sent.push({
        chat: body.chat_id,
        text: body.text,
        buttons: body.reply_markup?.inline_keyboard,
      })
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: sent.length + 100 } }),
    }
  }
  const bridge = new TelegramBridge({
    file: path.join(dir, 'telegram.json'),
    log: createLogger('test', 'error'),
    envToken: 'T',
    fetch,
    host: {
      async create(params) {
        created.push(params)
        append({
          type: 'session.created',
          sessionId: 's1',
          at: 1,
          instanceId: 'a',
          cwd: params.cwd,
          title: params.title ?? '',
        } as SessionEvent)
        return { sessionId: 's1' }
      },
      async prompt(id, text) {
        prompts.push([id, text])
      },
      async interrupt() {},
      async approve(...args) {
        approvals.push(args)
      },
      async answer() {},
      readSession: (id) => logs.get(id) ?? [],
      recentSessionIds: () => [...logs.keys()],
      projectPaths: async () => ['/work/alpha', '/work/beta'],
      hostLabel: 'box',
      providers: async () => [
        {
          id: 'a',
          kind: 'claude',
          label: 'Claude Code',
          status: 'ready',
          capabilities: {
            resume: true,
            fork: false,
            steer: false,
            planMode: false,
            imageInput: false,
            usage: false,
            permissionModes: [{ id: 'plan', label: 'Plan' }],
            models: [{ id: 'm1', label: 'Model One', efforts: ['low', 'high'] }],
            efforts: ['low', 'high'],
          },
        },
      ],
      subscribe: () => () => {},
    },
  })
  // Feeds a chat message through the same path as a polled update.
  const say = (chat: number, text: string) =>
    (bridge as unknown as { handle(t: string, u: unknown): Promise<void> }).handle('T', {
      update_id: 1,
      message: { message_id: 1, text, chat: { id: chat, type: 'private' } },
    })
  return { bridge, say, sent, prompts, approvals, created, append, deleted }
}

describe('TelegramBridge', () => {
  it('ignores strangers and pairs with the right code only', async () => {
    const { bridge, say, sent } = setup()
    await say(5, 'do something')
    await say(5, '/new alpha hi')
    expect(sent).toEqual([])
    const code = bridge.newPairCode()
    await say(5, '/pair 000000x')
    expect(bridge.status().chats).toBe(0)
    await say(5, `/pair ${code}`)
    expect(bridge.status().chats).toBe(1)
    expect(bridge.status().pairCode).toBeUndefined()
  })

  it('starts a session on a project and sends plain text to it', async () => {
    const { bridge, say, prompts, created } = setup()
    await say(5, `/pair ${bridge.newPairCode()}`)
    await say(5, '/new alp fix the bug')
    expect(created[0]?.cwd).toBe('/work/alpha')
    expect(prompts).toEqual([['s1', 'fix the bug']])
    await say(5, 'and add a test')
    expect(prompts[1]).toEqual(['s1', 'and add a test'])
  })

  it('sends approval buttons for watched sessions and applies the choice', async () => {
    const { bridge, say, sent, approvals, append } = setup()
    await say(5, `/pair ${bridge.newPairCode()}`)
    await say(5, '/new alpha go')
    await bridge.onEvent(
      append({
        type: 'approval.requested',
        sessionId: 's1',
        at: 2,
        requestId: 'r1',
        title: 'Run rm',
        options: [{ id: 'allow', label: 'Allow', kind: 'allow' }],
      } as SessionEvent),
    )
    const data = sent.at(-1)?.buttons?.[0]?.[0]?.callback_data
    expect(data).toBeDefined()
    await (bridge as unknown as { handle(t: string, u: unknown): Promise<void> }).handle('T', {
      update_id: 2,
      callback_query: { id: 'q', data, message: { chat: { id: 5, type: 'private' } } },
    })
    expect(approvals).toEqual([['s1', 'r1', 'allow']])
  })

  it('stays quiet about sessions it is not watching', async () => {
    const { bridge, say, sent, append } = setup()
    await say(5, `/pair ${bridge.newPairCode()}`)
    const before = sent.length
    await bridge.onEvent(
      append({ type: 'turn.completed', sessionId: 'other', at: 2, reason: 'done' } as SessionEvent),
    )
    expect(sent.length).toBe(before)
  })
  it('shows projects as buttons and takes the task in the next message', async () => {
    const { bridge, say, sent, prompts, created } = setup()
    await say(5, `/pair ${bridge.newPairCode()}`)
    await say(5, '/new')
    const rows = sent.at(-1)?.buttons ?? []
    expect(
      rows
        .flat()
        .map((b) => b.text)
        .sort(),
    ).toEqual(['alpha', 'beta'])
    const beta = rows.flat().find((b) => b.text === 'beta')!
    await (bridge as unknown as { handle(t: string, u: unknown): Promise<void> }).handle('T', {
      update_id: 3,
      callback_query: {
        id: 'q',
        data: beta.callback_data,
        message: { chat: { id: 5, type: 'private' } },
      },
    })
    expect(sent.at(-1)?.text).toContain('beta')
    await say(5, 'write the docs')
    expect(created[0]?.cwd).toBe('/work/beta')
    expect(prompts).toEqual([['s1', 'write the docs']])
  })

  it('lets the card set model, effort and permissions, and remembers them', async () => {
    const { bridge, say, sent, created } = setup()
    const handle = (u: unknown) =>
      (bridge as unknown as { handle(t: string, u: unknown): Promise<void> }).handle('T', u)
    const tap = async (label: string) => {
      const data = sent
        .at(-1)
        ?.buttons?.flat()
        .find((b) => b.text.replace('✓ ', '') === label)?.callback_data
      expect(data, label).toBeDefined()
      await handle({
        update_id: 9,
        callback_query: { id: 'q', data, message: { chat: { id: 5, type: 'private' } } },
      })
    }
    await say(5, `/pair ${bridge.newPairCode()}`)
    await say(5, '/new alpha')
    expect(sent.at(-1)?.text).toContain('New session on box')
    await tap('Model ▾')
    await tap('Model One')
    await tap('Effort ▾')
    await tap('high')
    await tap('Permissions ▾')
    await tap('Plan')
    expect(sent.at(-1)?.text).toContain('Effort: high')
    await say(5, 'do it')
    expect(created[0]).toMatchObject({
      cwd: '/work/alpha',
      model: 'm1',
      effort: 'high',
      permissionMode: 'plan',
    })
    // The next session starts from the same choices.
    await say(5, '/new beta again')
    expect(created[1]).toMatchObject({ cwd: '/work/beta', model: 'm1', effort: 'high' })
  })

  it('clears the chat but keeps messages that wait for an approval', async () => {
    const { bridge, say, sent, append, deleted } = setup()
    await say(5, `/pair ${bridge.newPairCode()}`)
    await say(5, '/new alpha go')
    await bridge.onEvent(
      append({
        type: 'approval.requested',
        sessionId: 's1',
        at: 2,
        requestId: 'r1',
        title: 'Run rm',
        options: [{ id: 'allow', label: 'Allow', kind: 'allow' }],
      } as SessionEvent),
    )
    const approvalId = 100 + sent.length
    await say(5, '/clear')
    expect(deleted).toContain(101)
    expect(deleted).not.toContain(approvalId)
    expect(sent.at(-1)?.text).toContain('Cleared')
    await say(5, 'no session now')
    expect(sent.at(-1)?.text).toContain('No session selected')
  })
})
