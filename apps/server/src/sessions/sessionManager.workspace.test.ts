import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
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
  const d = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beddcode-ws-')))
  dirs.push(d)
  return d
}
const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, windowsHide: true })

function repo() {
  const dir = tmp()
  sh(dir, 'init', '-q', '-b', 'main')
  sh(dir, 'config', 'user.name', 'T')
  sh(dir, 'config', 'user.email', 't@e.com')
  writeFileSync(path.join(dir, 'a.txt'), 'a\n')
  sh(dir, 'add', '-A')
  sh(dir, 'commit', '-q', '-m', 'init')
  return dir
}

const caps: ProviderCapabilities = {
  resume: true,
  fork: false,
  steer: false,
  planMode: false,
  imageInput: false,
  usage: false,
  permissionModes: [],
}

function setup(opts: { startFails?: boolean } = {}) {
  const starts: StartSessionInput[] = []
  const closed: string[] = []
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
      if (opts.startFails) throw new Error('agent failed to start')
      starts.push(input)
      const queue = createAsyncQueue<SessionEvent>()
      const session: ProviderSession = {
        sessionId: input.sessionId,
        events: queue,
        prompt: async () => {},
        interrupt: async () => {},
        setPermissionMode: async () => {},
        respondToApproval: async () => {},
        async close() {
          closed.push(input.sessionId)
          queue.close()
        },
      }
      return session
    },
  }
  const store = new EventStore(':memory:')
  const git = new GitService()
  const manager = new SessionManager({
    store,
    attachments: new AttachmentStore(path.join(tmp(), 'att')),
    git,
    adapters: [adapter],
    log: createLogger('test', 'error'),
    defaultCwd: tmp(),
  })
  return { manager, store, git, starts, closed }
}

const created = (store: EventStore, sessionId: string) =>
  store.readSession(sessionId).find((e) => e.event.type === 'session.created')!.event as Extract<
    SessionEvent,
    { type: 'session.created' }
  >

describe('SessionManager: workspaces', () => {
  it('runs a session in the repository itself by default', async () => {
    const { manager, store, starts } = setup()
    const dir = repo()
    const { sessionId } = await manager.create({ instanceId: 'rec', cwd: dir })
    expect(starts[0]?.cwd).toBe(dir)
    expect(created(store, sessionId)).toMatchObject({
      cwd: dir,
      projectPath: dir,
      branch: 'main',
    })
    expect(created(store, sessionId).worktree).toBeUndefined()
  })

  it('creates a worktree on a new branch and runs the agent there', async () => {
    const { manager, store, starts } = setup()
    const dir = repo()
    const { sessionId } = await manager.create({
      instanceId: 'rec',
      cwd: dir,
      workspace: { mode: 'worktree', branch: 'fix/limiter' },
    })
    const event = created(store, sessionId)
    expect(starts[0]?.cwd).toBe(path.join(dir, '.wt', 'fix-limiter'))
    expect(event).toMatchObject({
      cwd: path.join(dir, '.wt', 'fix-limiter'),
      projectPath: dir,
      branch: 'fix/limiter',
      worktree: { baseBranch: 'main' },
    })
    expect(existsSync(path.join(event.cwd, 'a.txt'))).toBe(true)
  })

  it('groups a session started from a subfolder under the repository', async () => {
    const { manager, store } = setup()
    const dir = repo()
    const sub = path.join(dir, 'sub')
    execFileSync(process.execPath, ['-e', `require('fs').mkdirSync(${JSON.stringify(sub)})`])
    const { sessionId } = await manager.create({ instanceId: 'rec', cwd: sub })
    expect(created(store, sessionId)).toMatchObject({ cwd: sub, projectPath: dir })
  })

  it('works in a plain folder, but refuses a worktree there', async () => {
    const { manager, store } = setup()
    const plain = tmp()
    const { sessionId } = await manager.create({ instanceId: 'rec', cwd: plain })
    expect(created(store, sessionId)).toMatchObject({
      cwd: plain,
      projectPath: plain,
    })
    expect(created(store, sessionId).branch).toBeUndefined()
    await expect(
      manager.create({ instanceId: 'rec', cwd: plain, workspace: { mode: 'worktree' } }),
    ).rejects.toThrow('git repository')
  })

  it('removes the worktree again when the agent fails to start', async () => {
    const { manager, git } = setup({ startFails: true })
    const dir = repo()
    await expect(
      manager.create({
        instanceId: 'rec',
        cwd: dir,
        workspace: { mode: 'worktree', branch: 'doomed' },
      }),
    ).rejects.toThrow('failed to start')
    expect(existsSync(path.join(dir, '.wt', 'doomed'))).toBe(false)
    expect((await git.branches(dir)).some((b) => b.name === 'doomed')).toBe(true)
  })

  it("deletes a session's worktree on request, stopping the agent first", async () => {
    const { manager, closed } = setup()
    const dir = repo()
    const { sessionId } = await manager.create({
      instanceId: 'rec',
      cwd: dir,
      workspace: { mode: 'worktree', branch: 'tmp' },
    })
    expect(await manager.removeWorktree(sessionId)).toBe(true)
    expect(closed).toContain(sessionId)
    expect(existsSync(path.join(dir, '.wt', 'tmp'))).toBe(false)
  })

  it('does nothing for a session that is not in a worktree', async () => {
    const { manager } = setup()
    const dir = repo()
    const { sessionId } = await manager.create({ instanceId: 'rec', cwd: dir })
    expect(await manager.removeWorktree(sessionId)).toBe(false)
    expect(existsSync(dir)).toBe(true)
  })
})
