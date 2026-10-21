import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderCapabilities, ProviderInstance, SessionEvent } from '@beddcode/contracts'
import type { ProviderAdapter, ProviderSession, StartSessionInput } from '@beddcode/provider-core'
import { createAsyncQueue, createLogger } from '@beddcode/shared'
import { AttachmentStore } from '../attachments/store.ts'
import { EventStore } from '../store/eventStore.ts'
import { GitService } from '../workspace/git.ts'
import { SessionManager } from './sessionManager.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-mgr-'))
  dirs.push(d)
  return d
}

const caps: ProviderCapabilities = {
  resume: true,
  fork: false,
  steer: false,
  planMode: false,
  imageInput: false,
  usage: false,
  permissionModes: [
    { id: 'ask', label: 'Ask before edits', description: 'Asks first' },
    { id: 'full', label: 'Full access', dangerous: true },
  ],
}

/** Records what the manager hands to a provider so tests can assert on it. */
function recordingAdapter() {
  const starts: StartSessionInput[] = []
  const prompts: string[] = []
  const modeCalls: string[] = []
  const instance: ProviderInstance = {
    id: 'rec',
    kind: 'claude',
    label: 'Rec',
    status: 'ready',
    capabilities: caps,
  }
  const adapter: ProviderAdapter = {
    kind: 'claude',
    detect: async () => [instance],
    capabilities: () => caps,
    async startSession(_id, input) {
      starts.push(input)
      const queue = createAsyncQueue<SessionEvent>()
      queue.push({
        type: 'session.provider-session',
        sessionId: input.sessionId,
        at: Date.now(),
        providerSessionId: `native-${starts.length}`,
      })
      const session: ProviderSession = {
        sessionId: input.sessionId,
        events: queue,
        async prompt(p) {
          prompts.push(p.text)
        },
        interrupt: async () => {},
        setPermissionMode: async (m) => {
          modeCalls.push(m)
        },
        respondToApproval: async () => {},
        close: async () => queue.close(),
      }
      return session
    },
  }
  return { adapter, starts, prompts, modeCalls }
}

function setup() {
  const store = new EventStore(':memory:')
  const attachments = new AttachmentStore(path.join(tmp(), 'att'))
  const rec = recordingAdapter()
  const make = () =>
    new SessionManager({
      store,
      attachments,
      git: new GitService(),
      adapters: [rec.adapter],
      log: createLogger('test', 'error'),
      defaultCwd: tmp(),
    })
  return { store, attachments, manager: make(), make, ...rec }
}

const events = (store: EventStore, sessionId: string) =>
  store.readSession(sessionId).map((e) => e.event)

describe('SessionManager: composer features', () => {
  it("records the starting mode, model and effort, and announces the provider's modes", async () => {
    const { store, manager, starts } = setup()
    const { sessionId } = await manager.create({
      instanceId: 'rec',
      permissionMode: 'full',
      model: 'opus',
      effort: 'high',
    })
    expect(starts[0]).toMatchObject({ permissionMode: 'full', model: 'opus', effort: 'high' })
    const all = events(store, sessionId)
    expect(all[0]).toMatchObject({ type: 'session.created', model: 'opus', effort: 'high' })
    expect(all.find((e) => e.type === 'session.modes')).toMatchObject({
      currentModeId: 'full',
      modes: [
        { id: 'ask', label: 'Ask before edits' },
        { id: 'full', label: 'Full access' },
      ],
    })
  })

  it("defaults to the provider's first mode when none is chosen", async () => {
    const { store, manager } = setup()
    const { sessionId } = await manager.create({ instanceId: 'rec' })
    expect(events(store, sessionId).find((e) => e.type === 'session.modes')).toMatchObject({
      currentModeId: 'ask',
    })
  })

  it('switches mode through the provider and records the new current mode', async () => {
    const { store, manager, modeCalls } = setup()
    const { sessionId } = await manager.create({ instanceId: 'rec' })
    await manager.setMode(sessionId, 'full')
    expect(modeCalls).toEqual(['full'])
    const modes = events(store, sessionId).filter((e) => e.type === 'session.modes')
    expect(modes.at(-1)).toMatchObject({ currentModeId: 'full' })
  })

  it('resumes in the last chosen mode, with the original model and effort', async () => {
    const { store, manager, make, starts } = setup()
    const { sessionId } = await manager.create({ instanceId: 'rec', model: 'opus', effort: 'low' })
    await manager.setMode(sessionId, 'full')
    await new Promise((r) => setTimeout(r, 5))

    await make().prompt(sessionId, 'continue')
    expect(starts[1]).toMatchObject({
      permissionMode: 'full',
      model: 'opus',
      effort: 'low',
      resumeId: 'native-1',
    })
    void store
  })

  it('refuses a folder that does not exist', async () => {
    const { manager } = setup()
    await expect(
      manager.create({ instanceId: 'rec', cwd: path.join(tmp(), 'missing') }),
    ).rejects.toThrow('Folder does not exist')
  })

  it('sends attachments to the agent as file paths and records them on the message', async () => {
    const { store, attachments, manager, prompts } = setup()
    const { sessionId } = await manager.create({ instanceId: 'rec' })
    const file = attachments.save('ingest.log', Buffer.from('boom'))

    await manager.prompt(sessionId, 'Why did this fail?', [file.id])

    expect(prompts[0]).toBe(`Why did this fail?\n\nAttached files:\n- ${file.path}`)
    const user = events(store, sessionId).find((e) => e.type === 'message.delta')
    expect(user).toMatchObject({
      role: 'user',
      text: 'Why did this fail?',
      attachments: [{ name: 'ingest.log', path: file.path }],
    })
  })

  it('allows an attachment-only prompt but not an empty one', async () => {
    const { attachments, manager, prompts } = setup()
    const { sessionId } = await manager.create({ instanceId: 'rec' })
    await expect(manager.prompt(sessionId, '   ')).rejects.toThrow('Nothing to send')

    const file = attachments.save('shot.png', Buffer.from('x'))
    await manager.prompt(sessionId, '', [file.id])
    expect(prompts[0]).toBe(`Attached files:\n- ${file.path}`)
  })

  it('rejects an unknown attachment id', async () => {
    const { manager } = setup()
    const { sessionId } = await manager.create({ instanceId: 'rec' })
    await expect(manager.prompt(sessionId, 'hi', ['nope'])).rejects.toThrow('attach it again')
  })
})
