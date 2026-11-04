import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { applyEvents, emptyReplica } from '@beddcode/client-runtime/replica'
import { createFakeAdapter, type ProviderAdapter } from '@beddcode/provider-core'
import { createLogger } from '@beddcode/shared'
import { AttachmentStore } from '../attachments/store.ts'
import { EventStore } from '../store/eventStore.ts'
import { GitService } from '../workspace/git.ts'
import { SessionManager } from './sessionManager.ts'

const clean: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const fn of clean.splice(0)) await fn()
})

async function setup(fail = false, resumeBehavior: 'normal' | 'unsupported' | 'lost' = 'normal') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'switch-test-'))
  const store = new EventStore(':memory:')
  const fake = createFakeAdapter({ delayMs: 0, advanced: true })
  const starts: { id: string; resumeId?: string; model?: string; effort?: string }[] = []
  const originalStart = fake.startSession.bind(fake)
  const originalCapabilities = fake.capabilities.bind(fake)
  fake.capabilities = (id) => ({
    ...originalCapabilities(id),
    resume: resumeBehavior !== 'unsupported',
  })
  fake.startSession = async (id, input) => {
    starts.push({ id, resumeId: input.resumeId, model: input.model, effort: input.effort })
    if (input.resumeId && resumeBehavior === 'lost') throw new Error('session not found')
    const session = await originalStart(id, input)
    const prompt = session.prompt.bind(session)
    session.prompt = async (input, signal) => {
      prompts.push(input.text)
      return prompt(input, signal)
    }
    return session
  }
  const prompts: string[] = []
  const target: ProviderAdapter = {
    ...fake,
    detect: async () => (await fake.detect()).map((i) => ({ ...i, id: 'target', label: 'Target' })),
    startSession: async (id, input) => {
      starts.push({ id, resumeId: input.resumeId, model: input.model, effort: input.effort })
      if (fail) throw new Error('target failed')
      const session = await fake.startSession(id, input)
      const prompt = session.prompt.bind(session)
      session.prompt = async (input, signal) => {
        prompts.push(input.text)
        return prompt(input, signal)
      }
      return session
    },
  }
  const manager = new SessionManager({
    store,
    attachments: new AttachmentStore(path.join(dir, 'attachments')),
    git: new GitService(),
    adapters: [fake, target],
    log: createLogger('test', 'error'),
    defaultCwd: dir,
  })
  clean.push(async () => {
    await manager.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })
  const { sessionId } = await manager.create({ instanceId: 'fake', cwd: dir, title: 'Goal' })
  return { manager, store, sessionId, prompts, starts }
}

it('resumes A after A to B to A and sends only the intervening context', async () => {
  const { manager, store, sessionId, prompts, starts } = await setup()
  await vi.waitFor(() => expect(store.sessionSegments(sessionId)[0]?.nativeSessionId).toBeTruthy())
  await manager.prompt(sessionId, 'old A request')
  await vi.waitFor(() =>
    expect(
      store.readSession(sessionId).some(({ event }) => event.type === 'approval.requested'),
    ).toBe(true),
  )
  expect((await manager.switchAgent({ sessionId, instanceId: 'target', stop: true })).ok).toBe(true)
  await vi.waitFor(() => expect(store.sessionSegments(sessionId)[1]?.nativeSessionId).toBeTruthy())
  await manager.prompt(sessionId, 'new B request')
  await vi.waitFor(() =>
    expect(
      store.readSession(sessionId).filter(({ event }) => event.type === 'approval.requested'),
    ).toHaveLength(2),
  )
  const result = await manager.switchAgent({ sessionId, instanceId: 'fake', stop: true })
  expect(result.ok).toBe(true)
  expect(starts.at(-1)?.resumeId).toBe(store.sessionSegments(sessionId)[0]?.nativeSessionId)
  expect(result.draft).toContain('new B request')
  expect(result.draft).not.toContain('\n- I asked: old A request')
  expect(store.sessionSegments(sessionId)[2]?.nativeSessionId).toBe(starts.at(-1)?.resumeId)
  await manager.prompt(sessionId, 'continue')
  await vi.waitFor(() => expect(prompts.at(-1)).toContain('new B request'))
  expect(prompts.at(-1)).not.toContain('\n- I asked: old A request')
})

it.each(['unsupported', 'lost'] as const)(
  'starts fresh with full context when resume is %s',
  async (behavior) => {
    const { manager, store, sessionId, starts } = await setup(false, behavior)
    await vi.waitFor(() =>
      expect(store.sessionSegments(sessionId)[0]?.nativeSessionId).toBeTruthy(),
    )
    store.append({
      type: 'message.delta',
      sessionId,
      at: 1,
      role: 'user',
      text: 'original request',
    })
    expect((await manager.switchAgent({ sessionId, instanceId: 'target' })).ok).toBe(true)
    const result = await manager.switchAgent({ sessionId, instanceId: 'fake' })
    expect(result.ok).toBe(true)
    expect(starts.at(-1)?.resumeId).toBeUndefined()
    expect(result.draft).toContain('original request')
    expect(result.draft).toContain('Original goal:')
  },
)

it('switches in the same session and supplies hidden bounded context with the next message', async () => {
  const { manager, store, sessionId, prompts } = await setup()
  const result = await manager.switchAgent({
    sessionId,
    instanceId: 'target',
    pendingMessage: 'finish it',
  })
  expect(result).toMatchObject({ ok: true })
  expect(result.draft).toContain('Pending user message: finish it')
  expect(result.draft.length).toBeLessThanOrEqual(6000)
  expect(store.sessionSegments(sessionId).map((s) => s.provider)).toEqual(['fake', 'target'])
  await manager.prompt(sessionId, 'continue')
  await vi.waitFor(() => expect(prompts[0]).toContain(result.draft))
  expect(
    store
      .readSession(sessionId)
      .some(
        ({ event }) =>
          event.type === 'message.delta' &&
          event.role === 'user' &&
          event.text.includes('Original goal:'),
      ),
  ).toBe(false)
})

it('refuses a running turn and returns its draft', async () => {
  const { manager, store, sessionId } = await setup()
  await manager.prompt(sessionId, 'hello')
  const result = await manager.switchAgent({ sessionId, instanceId: 'target' })
  expect(result).toMatchObject({ ok: false, error: expect.stringContaining('running') })
  expect(result.draft).toContain('hello')
  expect(store.sessionSegments(sessionId)).toHaveLength(1)
})

it('restores the old provider if the new provider fails to start', async () => {
  const { manager, store, sessionId } = await setup(true)
  const result = await manager.switchAgent({ sessionId, instanceId: 'target' })
  expect(result).toMatchObject({ ok: false, error: 'target failed' })
  expect(result.draft).toContain('Original goal:')
  expect(store.sessionSegments(sessionId)).toHaveLength(1)
  await expect(manager.prompt(sessionId, 'still working')).resolves.toEqual({ state: 'started' })
})

it('delivers a pending handoff after the host closes and resumes the active segment', async () => {
  const { manager, store, sessionId, prompts } = await setup()
  const result = await manager.switchAgent({ sessionId, instanceId: 'target' })
  expect(result.ok).toBe(true)
  await vi.waitFor(() => expect(store.sessionSegments(sessionId)[1]?.nativeSessionId).toBeTruthy())
  await manager.close()
  await manager.prompt(sessionId, 'after restart')
  await vi.waitFor(() => expect(prompts[0]).toContain(result.draft))
  expect(store.sessionSegments(sessionId)).toHaveLength(2)
})

it('previews without switching and sends the edited handoff', async () => {
  const { manager, store, sessionId, prompts } = await setup()
  const preview = await manager.switchAgent({ sessionId, instanceId: 'target', preview: true })
  expect(preview.draft).toContain('Original goal:')
  expect(store.sessionSegments(sessionId)).toHaveLength(1)
  const result = await manager.switchAgent({
    sessionId,
    instanceId: 'target',
    handoff: 'Edited handoff',
  })
  expect(result.ok).toBe(true)
  expect(store.sessionSegments(sessionId).at(-1)?.handoffContext).toBe('Edited handoff')
  await manager.prompt(sessionId, 'continue')
  await vi.waitFor(() => expect(prompts.at(-1)).toContain('Edited handoff'))
})

it('resets model and effort to the target agent last-used choice, else its default', async () => {
  const { manager, store, sessionId, starts } = await setup()
  const view = () =>
    applyEvents(emptyReplica(), store.readSession(sessionId)).sessions[sessionId]
  const choose = (model: string, effort: string) =>
    store.append({ type: 'session.model', sessionId, at: Date.now(), model, effort })
  choose('a-model', 'high')
  expect((await manager.switchAgent({ sessionId, instanceId: 'target' })).ok).toBe(true)
  expect(starts.at(-1)).toMatchObject({ id: 'target', model: undefined, effort: undefined })
  expect(view()).toMatchObject({ instanceId: 'target', model: undefined, effort: undefined })
  choose('b-model', 'low')
  expect((await manager.switchAgent({ sessionId, instanceId: 'fake' })).ok).toBe(true)
  expect(starts.at(-1)).toMatchObject({ id: 'fake', model: 'a-model', effort: 'high' })
  expect(view()).toMatchObject({ instanceId: 'fake', model: 'a-model', effort: 'high' })
  expect((await manager.switchAgent({ sessionId, instanceId: 'target' })).ok).toBe(true)
  expect(starts.at(-1)).toMatchObject({ id: 'target', model: 'b-model', effort: 'low' })
  expect(view()).toMatchObject({ instanceId: 'target', model: 'b-model', effort: 'low' })
})
