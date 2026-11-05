import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProviderCapabilities, ProviderInstance, SessionEvent } from '@beddcode/contracts'
import type { ProviderAdapter, ProviderSession } from '@beddcode/provider-core'
import { createAsyncQueue, createLogger } from '@beddcode/shared'
import { AttachmentStore } from '../attachments/store.ts'
import { EventStore } from '../store/eventStore.ts'
import { GitService } from '../workspace/git.ts'
import { SessionManager } from './sessionManager.ts'
import { recoverInterruptedTurns, takeInterruptedSessions } from './recovery.ts'

const caps: ProviderCapabilities = {
  resume: true,
  fork: false,
  steer: false,
  planMode: false,
  imageInput: false,
  usage: false,
  permissionModes: [],
}

/** An agent that starts a turn and then either hangs in a tool call (until the host is "killed")
 * or finishes the turn. */
function agent(behaviour: 'hang' | 'finish') {
  const prompts: string[] = []
  const resumeIds: (string | undefined)[] = []
  const instance: ProviderInstance = {
    id: 'stub',
    kind: 'acp',
    label: 'Stub',
    status: 'ready',
    capabilities: caps,
  }
  const adapter: ProviderAdapter = {
    kind: 'acp',
    detect: async () => [instance],
    capabilities: () => caps,
    async startSession(_id, input) {
      resumeIds.push(input.resumeId)
      const queue = createAsyncQueue<SessionEvent>()
      queue.push({
        type: 'session.provider-session',
        sessionId: input.sessionId,
        at: Date.now(),
        providerSessionId: 'native-1',
      })
      const session: ProviderSession = {
        sessionId: input.sessionId,
        events: queue,
        async prompt(prompt) {
          prompts.push(prompt.text)
          const base = { sessionId: input.sessionId, at: Date.now() }
          queue.push({ ...base, type: 'turn.started', turnId: 't1' })
          queue.push({ ...base, type: 'message.delta', role: 'assistant', text: 'working' })
          if (behaviour === 'hang') return
          queue.push({ ...base, type: 'message.delta', role: 'assistant', text: 'all done' })
          queue.push({ ...base, type: 'turn.completed', reason: 'done' })
        },
        interrupt: async () => {},
        setPermissionMode: async () => {},
        respondToApproval: async () => {},
        async close() {
          queue.close()
        },
      }
      return session
    },
  }
  return { adapter, prompts, resumeIds }
}

const deps = (store: EventStore, adapter: ProviderAdapter) => ({
  attachments: new AttachmentStore(path.join(os.tmpdir(), 'beddcode-autoresume-test')),
  git: new GitService(),
  store,
  adapters: [adapter],
  log: createLogger('test', 'error'),
  defaultCwd: os.tmpdir(),
  agentToolServers: () => [],
})

describe('host killed in the middle of a turn', () => {
  it('boots, resumes the turn by itself and finishes it, with no lost output', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-kill-'))
    const file = path.join(dir, 'beddcode.db')
    try {
      // First host: the agent is mid-turn when the process dies. No shutdown hook runs, so no
      // host.updating marker is written (a file-watch kill, a crash, SIGKILL).
      let store = new EventStore(file)
      const first = agent('hang')
      let manager = new SessionManager(deps(store, first.adapter))
      const { sessionId } = await manager.create({ instanceId: 'stub', projectless: true })
      await manager.prompt(sessionId, 'edit apps/server and keep going', [])
      await new Promise((r) => setTimeout(r, 200))
      await new Promise((r) => setTimeout(r, 50))
      expect(store.readSession(sessionId).map((r) => r.event.type)).not.toContain('turn.completed')
      store.close() // the process is gone

      // Second host boots, the way runServer does it.
      store = new EventStore(file)
      expect(recoverInterruptedTurns(store, 'auto')).toEqual([sessionId])
      const second = agent('finish')
      manager = new SessionManager(deps(store, second.adapter))
      await manager.resumeAfterRestart(takeInterruptedSessions())
      await new Promise((r) => setTimeout(r, 200))

      const events = store.readSession(sessionId).map((r) => r.event)
      const text = events.flatMap((e) => (e.type === 'message.delta' ? [e.text] : []))
      expect(text).toContain('working') // output from before the kill is kept
      expect(text).toContain('all done') // the resumed turn finished
      expect(events.at(-1)).toMatchObject({ type: 'turn.completed', reason: 'done' })
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'session.notice',
          message: expect.stringContaining('resumed automatically'),
        }),
      )
      expect(events.filter((e) => e.type === 'turn.interrupted')).toEqual([])
      expect(second.resumeIds).toEqual(['native-1'])
      expect(second.prompts[0]).toContain('edit apps/server and keep going')
      await manager.close()
      store.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
