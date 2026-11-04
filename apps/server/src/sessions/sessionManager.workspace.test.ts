import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  const d = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-ws-')))
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

function setup(opts: { startFails?: boolean; closeFails?: boolean } = {}) {
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
          if (opts.closeFails) throw new Error('Agent is still using this folder')
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
  it('shares concurrent automatic handoff creation and returns the existing destination on retry', async () => {
    const { manager, store, starts } = setup()
    try {
      const source = await manager.create({ instanceId: 'rec', title: 'Original' })
      const params = {
        instanceId: 'rec',
        handoffFrom: source.sessionId,
        handoffReason: 'rate limit',
      }
      const [first, second] = await Promise.all([manager.create(params), manager.create(params)])
      expect(second).toEqual(first)
      expect(await manager.create(params)).toEqual(first)
      expect(starts).toHaveLength(2)
      expect(
        store.readSession(source.sessionId).filter((e) => e.event.type === 'session.handed-off'),
      ).toHaveLength(1)
    } finally {
      await manager.close()
      store.close()
    }
  })

  it('continues in the source folder and records a durable link', async () => {
    const { manager, store, starts } = setup()
    try {
      const source = await manager.create({
        instanceId: 'rec',
        projectless: true,
        title: 'Original',
      })
      const next = await manager.create({
        instanceId: 'rec',
        handoffFrom: source.sessionId,
        handoffReason: 'rate limit',
      })
      expect(store.readSession(source.sessionId).map((e) => e.event)).toContainEqual(
        expect.objectContaining({
          type: 'session.handed-off',
          targetSessionId: next.sessionId,
          agent: 'Rec',
          reason: 'rate limit',
        }),
      )
      expect(starts[1]?.cwd).toBe(starts[0]?.cwd)
      expect(created(store, next.sessionId)).toMatchObject({
        cwd: starts[0]?.cwd,
        projectless: true,
        handoffFrom: { sessionId: source.sessionId, title: 'Original' },
      })
      await expect(
        manager.create({ instanceId: 'rec', handoffFrom: source.sessionId, cwd: tmp() }),
      ).rejects.toThrow('source session folder')
      await expect(manager.create({ instanceId: 'rec', handoffFrom: 'missing' })).rejects.toThrow(
        'Unknown session',
      )
    } finally {
      await manager.close()
      store.close()
    }
  })

  it('gives sessions without a project separate persistent folders and skips repository discovery', async () => {
    const { manager, store, git, starts } = setup()
    const info = vi.spyOn(git, 'info')
    try {
      const first = await manager.create({ instanceId: 'rec', projectless: true })
      const second = await manager.create({ instanceId: 'rec', projectless: true })
      const event = created(store, first.sessionId)
      expect(event).toMatchObject({ projectless: true, title: 'New session' })
      expect(event.branch).toBeUndefined()
      expect(event.worktree).toBeUndefined()
      expect(path.basename(event.cwd)).toBe(first.sessionId)
      expect(path.basename(path.dirname(event.cwd))).toBe('sessions')
      expect(starts[0]?.cwd).toBe(event.cwd)
      expect(starts[1]?.cwd).not.toBe(event.cwd)
      expect(path.basename(starts[1]!.cwd)).toBe(second.sessionId)
      writeFileSync(path.join(event.cwd, 'notes.txt'), 'Keep this')
      await manager.close()
      expect(existsSync(path.join(event.cwd, 'notes.txt'))).toBe(true)
      expect(info).not.toHaveBeenCalled()
    } finally {
      await manager.close()
      store.close()
    }
  })

  it('rejects mixing no project with a project folder or a worktree', async () => {
    const { manager, store, starts } = setup()
    try {
      await expect(
        manager.create({ instanceId: 'rec', projectless: true, cwd: tmp() }),
      ).rejects.toThrow('without a project')
      await expect(
        manager.create({ instanceId: 'rec', projectless: true, workspace: { mode: 'worktree' } }),
      ).rejects.toThrow('without a project')
      expect(starts).toHaveLength(0)
    } finally {
      await manager.close()
      store.close()
    }
  })

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

  it('keeps untracked work and the branch when cleanup is requested', async () => {
    const { manager, closed, git } = setup()
    const dir = repo()
    const { sessionId } = await manager.create({
      instanceId: 'rec',
      cwd: dir,
      workspace: { mode: 'worktree', branch: 'preserve' },
    })
    const cwd = path.join(dir, '.wt', 'preserve')
    writeFileSync(path.join(cwd, 'untracked.txt'), 'keep this')
    await expect(manager.removeWorktree(sessionId)).rejects.toThrow('uncommitted or untracked')
    expect(existsSync(path.join(cwd, 'untracked.txt'))).toBe(true)
    expect(closed).not.toContain(sessionId)
    expect((await git.branches(dir)).some((b) => b.name === 'preserve')).toBe(true)
  })
  it('keeps the worktree when its agent cannot be closed', async () => {
    const { manager } = setup({ closeFails: true })
    const dir = repo()
    const { sessionId } = await manager.create({
      instanceId: 'rec',
      cwd: dir,
      workspace: { mode: 'worktree', branch: 'busy-agent' },
    })
    await expect(manager.removeWorktree(sessionId)).rejects.toThrow(
      'Agent is still using this folder',
    )
    await expect(manager.removeWorktree(sessionId)).rejects.toThrow(
      'Agent is still using this folder',
    )
    expect(existsSync(path.join(dir, '.wt', 'busy-agent'))).toBe(true)
  })
})
