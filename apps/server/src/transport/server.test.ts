import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { ServerFrame, type StoredEvent } from '@beddcode/contracts'
import { AcpAgentStore, AcpRegistry, createAcpAdapter } from '@beddcode/provider-acp'
import { createFakeAdapter } from '@beddcode/provider-core'
import { createLogger } from '@beddcode/shared'
import { AgentCatalog } from '../agents/catalog.ts'
import { AttachmentStore } from '../attachments/store.ts'
import { SessionManager } from '../sessions/sessionManager.ts'
import { FileService } from '../files/files.ts'
import { FileWatchers } from '../files/watcher.ts'
import { TerminalManager } from '../terminals/manager.ts'
import { GitService } from '../workspace/git.ts'
import { GithubService } from '../workspace/github.ts'
import { ProjectStore } from '../workspace/projects.ts'
import { EventStore } from '../store/eventStore.ts'
import { startServer, type RunningServer } from './server.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn()
})

const registryJson = {
  agents: [
    {
      id: 'demo-npx',
      name: 'Demo Agent',
      version: '1.0.0',
      description: 'An npx agent',
      distribution: { npx: { package: 'demo-agent@1.0.0', args: ['--acp'] } },
    },
    {
      id: 'demo-binary',
      name: 'Binary Agent',
      version: '2.0.0',
      description: 'Needs a download',
      distribution: { binary: { 'windows-x86_64': {} } },
    },
  ],
}

async function boot(store = new EventStore(':memory:')) {
  const log = createLogger('test', 'error')
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-test-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  const acpStore = new AcpAgentStore(path.join(dir, 'acp-agents.json'))
  const attachments = new AttachmentStore(path.join(dir, 'attachments'))
  const git = new GitService()
  // A "shell" that upper-cases each line it is sent, so tests do not depend on a real shell.
  const terminals = new TerminalManager({
    shell: () => ({
      file: process.execPath,
      args: [
        '-e',
        'console.log("ready"); process.stdin.setEncoding("utf8"); process.stdin.on("data", d => console.log("ECHO:" + d.trim().toUpperCase()))',
      ],
      name: 'node',
    }),
  })
  const watchers = new FileWatchers()
  const sessions = new SessionManager({
    attachments,
    git,
    store,
    adapters: [createFakeAdapter({ delayMs: 0 }), createAcpAdapter({ store: acpStore, log })],
    log,
    defaultCwd: os.tmpdir(),
  })
  const agents = new AgentCatalog(
    acpStore,
    new AcpRegistry({ fetch: async () => Response.json(registryJson) }),
    () => sessions.invalidateDetection(),
  )
  const server: RunningServer = await startServer({
    port: 0,
    host: '127.0.0.1',
    hostId: 'host-1',
    hostName: 'test-host',
    store,
    sessions,
    agents,
    attachments,
    workspace: {
      git,
      github: new GithubService(),
      projects: new ProjectStore(path.join(dir, 'projects.json'), git),
      terminals,
      files: new FileService(),
    },
    watchers,
    log,
  })
  cleanup.push(
    () => sessions.close(),
    () => server.close(),
    () => terminals.shutdown(),
    () => watchers.closeAll(),
  )
  return { server, store }
}

class Client {
  frames: ServerFrame[] = []
  private waiters: (() => void)[] = []
  private constructor(readonly ws: WebSocket) {
    ws.on('message', (m) => {
      this.frames.push(ServerFrame.parse(JSON.parse(String(m))))
      this.waiters.splice(0).forEach((w) => w())
    })
  }
  static async connect(port: number) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    cleanup.push(() => ws.terminate())
    const c = new Client(ws)
    c.send({ t: 'hello', protocol: 1 })
    return c
  }
  send(frame: unknown) {
    this.ws.send(JSON.stringify(frame))
  }
  async until(predicate: (frames: ServerFrame[]) => boolean) {
    while (!predicate(this.frames)) {
      await new Promise<void>((resolve) => this.waiters.push(resolve))
    }
  }
  async rpc(method: string, params: unknown, id = Math.random().toString(36)) {
    this.send({ t: 'req', id, method, params })
    await this.until((fs) => fs.some((f) => f.t === 'res' && f.id === id))
    return this.frames.find((f) => f.t === 'res' && f.id === id) as Extract<
      ServerFrame,
      { t: 'res' }
    >
  }
  events(): StoredEvent[] {
    return this.frames.flatMap((f) => (f.t === 'event' ? [f.stored] : []))
  }
}

describe('server', () => {
  it('serves /health', async () => {
    const { server } = await boot()
    const res = await fetch(`http://127.0.0.1:${server.port}/health`)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
  })

  it('answers hello with welcome', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)
    await c.until((fs) => fs.some((f) => f.t === 'welcome'))
    const welcome = c.frames.find((f) => f.t === 'welcome')
    expect(welcome?.t === 'welcome' && welcome.host.hostId).toBe('host-1')
  })

  it('manages ACP agents: custom command, registry add, listing and removal', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)

    const custom = await c.rpc('agents.add', {
      label: 'My Agent',
      command: 'my-agent',
      args: ['--acp'],
    })
    expect(custom.result).toMatchObject({ id: 'my-agent', label: 'My Agent', args: ['--acp'] })
    // A second agent with the same label gets its own id.
    const again = await c.rpc('agents.add', { label: 'My Agent', command: 'other' })
    expect(again.result).toMatchObject({ id: 'my-agent-2' })

    const fromRegistry = await c.rpc('agents.add', { registryId: 'demo-npx' })
    expect(fromRegistry.result).toMatchObject({
      id: 'demo-npx',
      command: 'npx',
      args: ['-y', 'demo-agent@1.0.0', '--acp'],
      registryId: 'demo-npx',
    })
    const binary = await c.rpc('agents.add', { registryId: 'demo-binary' })
    expect(binary.ok).toBe(false)
    expect(binary.error).toContain('not supported')

    const listed = await c.rpc('agents.list', {})
    expect((listed.result as { id: string }[]).map((a) => a.id)).toEqual([
      'my-agent',
      'my-agent-2',
      'demo-npx',
    ])

    // New agents show up as providers straight away, as not-installed when the command is missing.
    const providers = await c.rpc('providers.list', {})
    expect(
      (providers.result as { id: string; kind: string; status: string }[]).filter(
        (p) => p.kind === 'acp',
      ),
    ).toMatchObject([
      { id: 'acp:my-agent', status: 'not-installed' },
      { id: 'acp:my-agent-2', status: 'not-installed' },
      { id: 'acp:demo-npx', status: expect.stringMatching(/ready|not-installed/) },
    ])

    expect((await c.rpc('agents.remove', { id: 'my-agent' })).result).toEqual({ removed: true })
    expect((await c.rpc('agents.remove', { id: 'my-agent' })).result).toEqual({ removed: false })
  })

  it('lists and filters the ACP registry and flags binary-only agents', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)
    const all = (await c.rpc('agents.registry', {})).result as {
      id: string
      installable: boolean
    }[]
    expect(all.map((a) => [a.id, a.installable])).toEqual([
      ['demo-npx', true],
      ['demo-binary', false],
    ])
    const filtered = (await c.rpc('agents.registry', { query: 'binary' })).result as {
      id: string
    }[]
    expect(filtered.map((a) => a.id)).toEqual(['demo-binary'])
  })

  it('serves projects, git status, commits and worktree sessions through the API', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)

    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beddcode-api-')))
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
    const sh = (...args: string[]) => execFileSync('git', args, { cwd: dir, windowsHide: true })
    sh('init', '-q', '-b', 'main')
    sh('config', 'user.name', 'T')
    sh('config', 'user.email', 't@e.com')
    writeFileSync(path.join(dir, 'a.txt'), 'one\n')
    sh('add', '-A')
    sh('commit', '-q', '-m', 'init')

    const project = await c.rpc('projects.add', { path: dir })
    expect(project.result).toMatchObject({ path: dir, isRepo: true, branch: 'main' })
    expect(((await c.rpc('projects.list', {})).result as unknown[]).length).toBe(1)

    writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n')
    const status = await c.rpc('git.status', { cwd: dir })
    expect(status.result).toMatchObject({
      branch: 'main',
      files: [{ path: 'a.txt', status: 'M', added: 1, removed: 0 }],
    })
    expect((await c.rpc('git.diff', { cwd: dir, path: 'a.txt' })).result).toMatchObject({
      added: 1,
    })

    const commit = await c.rpc('git.commit', { cwd: dir, message: 'add two', paths: ['a.txt'] })
    expect(commit.ok).toBe(true)
    const log = (await c.rpc('git.log', { cwd: dir })).result as { unpushed: { subject: string }[] }
    expect(log.unpushed[0]?.subject).toBe('add two')
    expect((await c.rpc('git.commit', { cwd: dir, message: 'x', paths: ['../escape'] })).ok).toBe(
      false,
    )

    const created = await c.rpc('sessions.create', {
      instanceId: 'fake',
      cwd: dir,
      workspace: { mode: 'worktree', branch: 'topic' },
    })
    expect(created.ok).toBe(true)
    const branches = (await c.rpc('git.branches', { cwd: dir })).result as {
      name: string
      worktree?: string
    }[]
    expect(branches.find((b) => b.name === 'topic')?.worktree).toBe(path.join(dir, '.wt', 'topic'))

    const { sessionId } = created.result as { sessionId: string }
    expect((await c.rpc('worktrees.remove', { sessionId })).result).toEqual({ removed: true })
    expect((await c.rpc('projects.remove', { path: dir })).result).toEqual({ removed: true })
  })

  it('runs a terminal over the connection: attach, input, output, reattach with history, close', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beddcode-term-api-')))
    cleanup.push(() =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }),
    )

    const created = await c.rpc('terminals.create', { cwd: dir, cols: 100, rows: 30 })
    const info = created.result as { id: string; shell: string; cols: number }
    expect(info).toMatchObject({ shell: 'node', cols: 100 })
    expect(((await c.rpc('terminals.list', { cwd: dir })).result as unknown[]).length).toBe(1)

    c.send({ t: 'term.attach', id: info.id })
    const out = () => c.frames.flatMap((f) => (f.t === 'term.out' ? [f.data] : [])).join('')
    await c.until(() => out().includes('ready'))

    c.send({ t: 'term.input', id: info.id, data: 'hello\r\n' })
    await c.until(() => out().includes('ECHO:HELLO'))
    c.send({ t: 'term.resize', id: info.id, cols: 120, rows: 40 })

    // A second connection attaching later gets the history.
    const other = await Client.connect(server.port)
    other.send({ t: 'term.attach', id: info.id })
    await other.until((fs) =>
      fs.some((f) => f.t === 'term.out' && f.replay === true && f.data.includes('ECHO:HELLO')),
    )

    expect((await c.rpc('terminals.close', { id: info.id })).ok).toBe(true)
    await c.until((fs) => fs.some((f) => f.t === 'term.exit'))
    expect(((await c.rpc('terminals.list', {})).result as unknown[]).length).toBe(0)

    const missing = await Client.connect(server.port)
    missing.send({ t: 'term.attach', id: 'nope' })
    await missing.until((fs) => fs.some((f) => f.t === 'term.exit'))
    expect((await c.rpc('terminals.create', { cwd: path.join(dir, 'missing') })).ok).toBe(false)
  })

  it('serves files and pushes change notifications to watchers', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)
    const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'beddcode-files-api-')))
    cleanup.push(() =>
      rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }),
    )
    writeFileSync(path.join(dir, 'a.txt'), 'one\n')

    expect(
      ((await c.rpc('files.list', { cwd: dir })).result as { entries: { name: string }[] }).entries,
    ).toEqual([{ name: 'a.txt', type: 'file', size: 4 }])
    const read = (await c.rpc('files.read', { cwd: dir, path: 'a.txt' })).result as {
      content: string
      mtime: number
    }
    expect(read.content).toBe('one\n')

    const saved = await c.rpc('files.write', {
      cwd: dir,
      path: 'a.txt',
      content: 'two\n',
      expectedMtime: read.mtime,
    })
    expect(saved.ok).toBe(true)
    expect((await c.rpc('files.create', { cwd: dir, path: 'src/new.ts', type: 'file' })).ok).toBe(
      true,
    )
    expect(
      ((await c.rpc('files.search', { cwd: dir, query: 'new' })).result as { paths: string[] })
        .paths,
    ).toEqual(['src/new.ts'])
    const escape = await c.rpc('files.read', { cwd: dir, path: '../x' })
    expect(escape.ok).toBe(false)
    expect(escape.error).toContain('outside the folder')

    c.send({ t: 'fs.watch', cwd: dir })
    await new Promise((r) => setTimeout(r, 600))
    writeFileSync(path.join(dir, 'b.txt'), 'new')
    await c.until((fs) => fs.some((f) => f.t === 'fs.changed' && f.paths.includes('b.txt')))
    c.send({ t: 'fs.unwatch', cwd: dir })
  })

  it('rejects unknown methods and bad params', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)
    expect((await c.rpc('nope', {})).ok).toBe(false)
    expect((await c.rpc('sessions.prompt', { sessionId: 1 })).ok).toBe(false)
  })

  it('runs a fake session and streams its events to a subscriber', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)
    c.send({ t: 'subscribe', afterSeq: 0 })
    await c.until((fs) => fs.some((f) => f.t === 'caught-up'))

    const created = await c.rpc('sessions.create', { instanceId: 'fake', title: 'Demo' })
    expect(created.ok).toBe(true)
    const { sessionId } = created.result as { sessionId: string }

    await c.rpc('sessions.prompt', { sessionId, text: 'fix the limiter' })
    await c.until((fs) =>
      fs.some((f) => f.t === 'event' && f.stored.event.type === 'approval.requested'),
    )
    const request = c
      .events()
      .map((e) => e.event)
      .find((e) => e.type === 'approval.requested')
    if (request?.type !== 'approval.requested') throw new Error('expected approval request')

    await c.rpc('sessions.approve', { sessionId, requestId: request.requestId, optionId: 'allow' })
    await c.until((fs) =>
      fs.some((f) => f.t === 'event' && f.stored.event.type === 'turn.completed'),
    )

    const types = c.events().map((e) => e.event.type)
    expect(types[0]).toBe('session.created')
    expect(types).toContain('tool.completed')
    expect(types).toContain('diff')
    expect(types.at(-1)).toBe('turn.completed')
    const seqs = c.events().map((e) => e.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  it('resumes after a reconnect without gaps or duplicates', async () => {
    const { server, store } = await boot()
    const first = await Client.connect(server.port)
    first.send({ t: 'subscribe', afterSeq: 0 })
    await first.until((fs) => fs.some((f) => f.t === 'caught-up'))
    const { result } = await first.rpc('sessions.create', {
      instanceId: 'fake',
      permissionMode: 'full',
    })
    const { sessionId } = result as { sessionId: string }
    await first.rpc('sessions.prompt', { sessionId, text: 'one' })
    await first.until((fs) =>
      fs.some((f) => f.t === 'event' && f.stored.event.type === 'turn.completed'),
    )
    const lastSeen = first.events().at(-1)!.seq
    first.ws.terminate()

    // More events happen while the client is away.
    await new Promise((r) => setTimeout(r, 10))
    store.append({ type: 'error', sessionId, at: Date.now(), message: 'while away' })

    const second = await Client.connect(server.port)
    second.send({ t: 'subscribe', afterSeq: lastSeen })
    await second.until((fs) => fs.some((f) => f.t === 'caught-up'))
    const replayed = second.events()
    expect(replayed.map((e) => e.seq)).toEqual([lastSeen + 1])
    expect(replayed[0]?.event.type).toBe('error')
  })
})
