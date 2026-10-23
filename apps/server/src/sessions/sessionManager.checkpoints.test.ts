import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProviderCapabilities, ProviderInstance, SessionEvent } from '@beddcode/contracts'
import type { ProviderAdapter, ProviderSession } from '@beddcode/provider-core'
import { createAsyncQueue, createLogger } from '@beddcode/shared'
import { AttachmentStore } from '../attachments/store.ts'
import { EventStore } from '../store/eventStore.ts'
import { GitService } from '../workspace/git.ts'
import { SessionManager } from './sessionManager.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-cp-')))
  dirs.push(d)
  return d
}
const sh = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })

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
  resume: false,
  fork: false,
  steer: false,
  planMode: false,
  imageInput: false,
  usage: false,
  permissionModes: [],
}

/** An agent whose "work" is whatever the test's `edit` callback does to the folder. */
function setup(edit: (cwd: string, text: string) => void) {
  const instance: ProviderInstance = {
    id: 'ed',
    kind: 'claude',
    label: 'Editor',
    status: 'ready',
    capabilities: caps,
  }
  let turns = 0
  const adapter: ProviderAdapter = {
    kind: 'claude',
    detect: async () => [instance],
    capabilities: () => caps,
    async startSession(_id, input) {
      const queue = createAsyncQueue<SessionEvent>()
      const emit = (event: Record<string, unknown>) =>
        queue.push({ sessionId: input.sessionId, at: Date.now(), ...event } as SessionEvent)
      const session: ProviderSession = {
        sessionId: input.sessionId,
        events: queue,
        prompt: async ({ text }) => {
          const turnId = `t${++turns}`
          emit({ type: 'turn.started', turnId })
          edit(input.cwd, text)
          emit({ type: 'turn.completed', turnId, reason: 'done' })
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
  const store = new EventStore(':memory:')
  const manager = new SessionManager({
    store,
    attachments: new AttachmentStore(path.join(tmp(), 'att')),
    git: new GitService(),
    adapters: [adapter],
    log: createLogger('test', 'error'),
    defaultCwd: tmp(),
  })
  return { manager, store }
}

const events = (store: EventStore, sessionId: string) =>
  store.readSession(sessionId).map((e) => e.event)

async function until<T>(read: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 20))
  }
}

const changesOf = (store: EventStore, sessionId: string, n = 1) =>
  until(() => {
    const found = events(store, sessionId).filter((e) => e.type === 'turn.changes')
    return found.length >= n
      ? (found[n - 1] as Extract<SessionEvent, { type: 'turn.changes' }>)
      : undefined
  })

describe('SessionManager: turn changes and undo', () => {
  it('records what a turn changed, shows a file diff, and undoes the latest turn', async () => {
    const dir = repo()
    const { manager, store } = setup((cwd, text) => {
      if (text === 'edit') {
        writeFileSync(path.join(cwd, 'a.txt'), 'a\nb\n')
        writeFileSync(path.join(cwd, 'new.txt'), 'new\n')
      }
    })
    const { sessionId } = await manager.create({ instanceId: 'ed', cwd: dir })
    await manager.prompt(sessionId, 'edit')
    const changes = await changesOf(store, sessionId)
    expect(changes.turnId).toBe('t1')
    expect(changes.files).toEqual([
      { path: 'a.txt', status: 'M', added: 1, removed: 0 },
      { path: 'new.txt', status: 'A', added: 1, removed: 0 },
    ])
    // The user's git state is untouched by the snapshots.
    expect(sh(dir, 'status', '--porcelain')).toBe(' M a.txt\n?? new.txt\n')
    expect(
      sh(dir, 'for-each-ref', '--format=%(refname)', 'refs/beddcode/').split('\n'),
    ).toHaveLength(3)

    const diff = await manager.turnDiff(sessionId, changes.after, 'a.txt')
    expect(diff.patch).toContain('+b')
    await expect(manager.turnDiff(sessionId, changes.after, 'other.txt')).rejects.toThrow(
      /did not change/,
    )

    expect(await manager.undoTurn(sessionId, changes.after)).toEqual({ restored: 2 })
    expect(readFileSync(path.join(dir, 'a.txt'), 'utf8')).toBe('a\n')
    expect(existsSync(path.join(dir, 'new.txt'))).toBe(false)
    expect(events(store, sessionId).at(-1)).toMatchObject({
      type: 'turn.reverted',
      after: changes.after,
    })
    await expect(manager.undoTurn(sessionId, changes.after)).rejects.toThrow(/already undone/)
  })

  it('records nothing for a turn that changed nothing, and refuses unsafe undos', async () => {
    const dir = repo()
    const { manager, store } = setup((cwd, text) => {
      if (text.startsWith('write')) writeFileSync(path.join(cwd, `${text}.txt`), text)
    })
    const { sessionId } = await manager.create({ instanceId: 'ed', cwd: dir })
    await manager.prompt(sessionId, 'just talk')
    await until(() =>
      events(store, sessionId).some((e) => e.type === 'turn.completed') ? true : undefined,
    )
    await new Promise((r) => setTimeout(r, 300))
    expect(events(store, sessionId).some((e) => e.type === 'turn.changes')).toBe(false)
    expect(sh(dir, 'for-each-ref', 'refs/beddcode/')).toBe('')

    await manager.prompt(sessionId, 'write1')
    const first = await changesOf(store, sessionId, 1)
    await manager.prompt(sessionId, 'write2')
    const second = await changesOf(store, sessionId, 2)
    await expect(manager.undoTurn(sessionId, first.after)).rejects.toThrow(/latest/)

    // The user edited the folder after the turn: undoing would lose that.
    writeFileSync(path.join(dir, 'mine.txt'), 'mine')
    await expect(manager.undoTurn(sessionId, second.after)).rejects.toThrow(/changed after/)
    rmSync(path.join(dir, 'mine.txt'))
    expect(await manager.undoTurn(sessionId, second.after)).toEqual({ restored: 1 })
    expect(existsSync(path.join(dir, 'write2.txt'))).toBe(false)
    expect(existsSync(path.join(dir, 'write1.txt'))).toBe(true)
  })

  it('skips folders that are not repositories, and pins sessions', async () => {
    const dir = tmp()
    const { manager, store } = setup((cwd) => writeFileSync(path.join(cwd, 'x.txt'), 'x'))
    const { sessionId } = await manager.create({ instanceId: 'ed', cwd: dir })
    await manager.prompt(sessionId, 'edit')
    await until(() =>
      events(store, sessionId).some((e) => e.type === 'turn.completed') ? true : undefined,
    )
    await new Promise((r) => setTimeout(r, 200))
    expect(events(store, sessionId).some((e) => e.type === 'turn.changes')).toBe(false)

    manager.setPinned(sessionId, true)
    expect(events(store, sessionId).at(-1)).toMatchObject({ type: 'session.pinned', pinned: true })
    expect(() => manager.setPinned('nope', true)).toThrow(/Unknown session/)
  })
})
