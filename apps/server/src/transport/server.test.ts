import { execFileSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { ServerFrame, type StoredEvent } from '@beddcode/contracts'
import { AcpAgentStore, AcpRegistry, createAcpAdapter } from '@beddcode/provider-acp'
import { createFakeAdapter } from '@beddcode/provider-core'
import { createLogger } from '@beddcode/shared'
import { AgentCatalog } from '../agents/catalog.ts'
import { AttachmentStore } from '../attachments/store.ts'
import { defaultGuard, type GuardOptions } from '../auth/guard.ts'
import { PairingManager } from '../auth/pairing.ts'
import { TokenStore } from '../auth/tokens.ts'
import { TailscaleService } from '../network/tailscale.ts'
import { SessionManager } from '../sessions/sessionManager.ts'
import { FileService } from '../files/files.ts'
import { FileWatchers } from '../files/watcher.ts'
import { TerminalManager } from '../terminals/manager.ts'
import { GitService } from '../workspace/git.ts'
import { GithubService } from '../workspace/github.ts'
import { ProjectStore } from '../workspace/projects.ts'
import { EventStore } from '../store/eventStore.ts'
import { startServer, type RunningServer } from './server.ts'
import { createAutomation } from '../automation/index.ts'
import { HostClient } from '../../../../packages/client-runtime/src/hostClient.ts'
import { applyEvent, emptyReplica } from '../../../../packages/client-runtime/src/replica.ts'

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

async function boot(
  store = new EventStore(':memory:'),
  guard?: GuardOptions,
  hostId = 'host-1',
  extra: { idleTimeoutMs?: number } = {},
) {
  cleanup.push(() => store.close())
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
  let port = 0
  let tools: ReturnType<typeof createAutomation>['agentTools'] | undefined
  const sessions = new SessionManager({
    agentToolServers: (id) => tools?.serversFor(id) ?? [],
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
  const tokens = new TokenStore(path.join(dir, 'auth.json'))
  const pairing = new PairingManager()
  const workspace = {
    git,
    github: new GithubService(),
    projects: new ProjectStore(path.join(dir, 'projects.json'), git),
    terminals,
    files: new FileService(),
  }
  const pushes: { url: string; body: unknown }[] = []
  const automation = createAutomation({
    home: dir,
    hostId,
    sessions,
    store,
    workspace,
    port: () => port,
    tickMs: 20,
    fetch: async (url, init) => {
      const body = JSON.parse(init.body) as unknown[]
      pushes.push({ url, body })
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: (Array.isArray(body) ? body : [body]).map(() => ({ status: 'ok' })),
        }),
      }
    },
  })
  tools = automation.agentTools
  tokens.onRevoke((id) => automation.alerts.forgetDevice(id))
  const server: RunningServer = await startServer({
    ...extra,
    guard,
    tokens,
    pairing,
    tailscale: new TailscaleService({ exe: null }),
    port: 0,
    host: '127.0.0.1',
    hostId,
    hostName: 'test-host',
    store,
    sessions,
    agents,
    attachments,
    workspace,
    watchers,
    automation,
    agentTools: automation.agentTools,
    log,
  })
  port = server.port
  automation.schedules.start()
  cleanup.push(
    () => automation.stop(),
    () => sessions.close(),
    () => server.close(),
    () => terminals.shutdown(),
    () => watchers.closeAll(),
  )
  return { server, store, tokens, pairing, attachments, automation, sessions, pushes, dir }
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
  static async connect(
    port: number,
    opts: { token?: string; origin?: string; headers?: Record<string, string> } = {},
  ) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: opts.origin,
      headers: opts.headers,
    })
    await new Promise((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    cleanup.push(() => ws.terminate())
    const c = new Client(ws)
    c.send({ t: 'hello', protocol: 1, token: opts.token })
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
    expect(binary.error).toContain('No build for this machine')

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

    const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-api-')))
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

    // Saved commands: one runs in every new worktree, in its own terminal.
    const scripts = [
      { id: 'setup', name: 'Setup', command: 'setup deps', runOnWorktreeCreate: true },
      { id: 'test', name: 'Test', command: 'run tests' },
    ]
    const saved = await c.rpc('projects.setScripts', { path: dir, scripts })
    expect(saved.result).toMatchObject({ path: dir, scripts })
    expect((await c.rpc('projects.list', {})).result).toMatchObject([{ scripts }])
    expect(
      (await c.rpc('projects.setScripts', { path: path.join(dir, 'nope'), scripts: [] })).ok,
    ).toBe(false)

    const created = await c.rpc('sessions.create', {
      instanceId: 'fake',
      cwd: dir,
      workspace: { mode: 'worktree', branch: 'topic' },
    })
    expect(created.ok).toBe(true)
    const wtTerms = (await c.rpc('terminals.list', { cwd: path.join(dir, '.wt', 'topic') }))
      .result as { id: string; title?: string }[]
    expect(wtTerms).toMatchObject([{ title: 'Setup' }])
    c.send({ t: 'term.attach', id: wtTerms[0]!.id })
    await c.until((fs) => fs.some((f) => f.t === 'term.out' && f.data.includes('ECHO:SETUP DEPS')))
    await c.rpc('terminals.close', { id: wtTerms[0]!.id })
    const branches = (await c.rpc('git.branches', { cwd: dir })).result as {
      name: string
      worktree?: string
    }[]
    expect(branches.find((b) => b.name === 'topic')?.worktree).toBe(path.join(dir, '.wt', 'topic'))

    const { sessionId } = created.result as { sessionId: string }
    expect((await c.rpc('worktrees.remove', { sessionId })).result).toEqual({ removed: true })
    expect((await c.rpc('projects.remove', { path: dir })).result).toEqual({ removed: true })

    // The folder browser lists subfolders only (never files), straight off the host's disk.
    mkdirSync(path.join(dir, 'sub'))
    const browsed = (await c.rpc('folders.browse', { path: dir })).result as {
      path: string
      entries: { name: string; isRepo: boolean }[]
    }
    expect(browsed.path).toBe(dir)
    expect(browsed.entries).toEqual([expect.objectContaining({ name: 'sub', isRepo: false })])
    expect((await c.rpc('folders.browse', { path: 'relative' })).ok).toBe(false)

    // An image is fetched over HTTP with the ticket the connection handed out, and only with it.
    writeFileSync(path.join(dir, 'pic.png'), Buffer.from([137, 80, 78, 71]))
    const shown = (await c.rpc('files.media', { cwd: dir, path: 'pic.png' })).result as {
      url: string
      kind: string
    }
    expect(shown.kind).toBe('image')
    const fetched = await fetch(`http://127.0.0.1:${server.port}${shown.url}`)
    expect(fetched.status).toBe(200)
    expect([...new Uint8Array(await fetched.arrayBuffer())]).toEqual([137, 80, 78, 71])
    expect((await fetch(`http://127.0.0.1:${server.port}/media/guess`)).status).toBe(404)
    expect((await c.rpc('files.media', { cwd: dir, path: 'README.md' })).result).toBeNull()
  })

  it('runs a terminal over the connection: attach, input, output, reattach with history, close', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)
    const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-term-api-')))
    cleanup.push(() => {
      // Windows keeps a just-killed shell's folder locked for a moment; a leftover temp dir is harmless.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 })
      } catch {
        // ignored
      }
    })

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
    const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-files-api-')))
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

  it('snapshots workspace attachments and delivers them through a prompt', async () => {
    const { server, store, attachments } = await boot()
    const c = await Client.connect(server.port)
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'beddcode-context-'))
    cleanup.push(() => rmSync(cwd, { recursive: true, force: true }))
    const image = Buffer.from([137, 80, 78, 71, 0, 255])
    writeFileSync(path.join(cwd, 'image.png'), image)
    const saved = await c.rpc('attachments.fromFile', { cwd, path: 'image.png' })
    expect(saved).toMatchObject({ ok: true })
    const { id } = saved.result as { id: string }
    writeFileSync(path.join(cwd, 'image.png'), 'changed after attaching')
    expect(readFileSync(attachments.get(id)!.path)).toEqual(image)
    const created = await c.rpc('sessions.create', { instanceId: 'fake', cwd })
    const { sessionId } = created.result as { sessionId: string }
    expect((await c.rpc('sessions.prompt', { sessionId, text: '', attachments: [id] })).ok).toBe(
      true,
    )
    const user = store
      .readSession(sessionId)
      .map((e) => e.event)
      .find((e) => e.type === 'message.delta' && e.role === 'user')
    expect(user).toMatchObject({
      attachments: [{ name: 'image.png', path: attachments.get(id)!.path }],
    })
    expect((await c.rpc('attachments.fromFile', { cwd, path: '../outside' })).ok).toBe(false)
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

describe('silent connections', () => {
  it('closes a connection that stops answering, and keeps one that pings', async () => {
    const { server } = await boot(undefined, undefined, 'host-1', { idleTimeoutMs: 200 })
    const url = `ws://127.0.0.1:${server.port}/ws`
    const open = (autoPong: boolean) =>
      new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(url, { autoPong })
        ws.once('open', () => resolve(ws))
        ws.once('error', reject)
      })
    // Gone to sleep: sends nothing and does not answer socket pings.
    const asleep = await open(false)
    // An app in use: pings like the client runtime does.
    const awake = await open(true)
    const timer = setInterval(() => awake.send(JSON.stringify({ t: 'ping' })), 50)
    cleanup.push(() => clearInterval(timer))
    // An idle but healthy socket: never sends, but its socket answers pings.
    const idle = await open(true)
    const closed = new Promise<number>((resolve) => asleep.once('close', (code) => resolve(code)))
    expect(await closed).toBe(1006)
    await new Promise((r) => setTimeout(r, 300))
    expect(awake.readyState).toBe(WebSocket.OPEN)
    expect(idle.readyState).toBe(WebSocket.OPEN)
    for (const ws of [awake, idle]) ws.close()
  })
})

describe('access control', () => {
  const pair = (port: number, body: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })

  it('refuses web pages from other origins before the socket opens', async () => {
    const { server } = await boot()
    await expect(Client.connect(server.port, { origin: 'https://evil.example' })).rejects.toThrow(
      /403/,
    )
    const ok = await Client.connect(server.port, { origin: 'http://localhost:5173' })
    await ok.until((fs) => fs.some((f) => f.t === 'welcome'))
  })

  it('lets this machine in without a token, but demands one when configured', async () => {
    const { server, tokens } = await boot(undefined, { ...defaultGuard(), requireToken: true })

    const anon = await Client.connect(server.port)
    await anon.until((fs) => fs.some((f) => f.t === 'denied'))
    expect(anon.frames.find((f) => f.t === 'denied')).toMatchObject({ reason: 'auth' })

    const wrong = await Client.connect(server.port, { token: 'nope' })
    await wrong.until((fs) => fs.some((f) => f.t === 'denied'))

    const { token } = tokens.issue('test device')
    const good = await Client.connect(server.port, { token })
    await good.until((fs) => fs.some((f) => f.t === 'welcome'))
    expect((await good.rpc('providers.list', {})).ok).toBe(true)
  })

  it('routes /tunnel to port forwarding behind the same token, and refuses other paths', async () => {
    const { server, tokens } = await boot(undefined, { ...defaultGuard(), requireToken: true })
    const { createServer } = await import('node:net')
    const target = createServer((s) => s.on('data', (d) => s.write(String(d).toUpperCase())))
    await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((resolve) => target.close(() => resolve())))
    const targetPort = (target.address() as { port: number }).port
    const tunnel = (token?: string) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/tunnel`)
      cleanup.push(() => ws.terminate())
      ws.once('open', () => ws.send(JSON.stringify({ t: 'open', port: targetPort, token })))
      return ws
    }
    const anon = tunnel()
    expect(await new Promise((resolve) => anon.once('close', resolve))).toBe(1008)

    const { token } = tokens.issue('laptop')
    const ws = tunnel(token)
    const echoed = new Promise<string>((resolve) =>
      ws.on('message', (data, binary) => {
        if (!binary) ws.send(Buffer.from('ping'), { binary: true })
        else resolve(String(data))
      }),
    )
    expect(await echoed).toBe('PING')

    const other = new WebSocket(`ws://127.0.0.1:${server.port}/elsewhere`)
    await expect(
      new Promise((resolve, reject) => {
        other.once('open', resolve)
        other.once('error', reject)
      }),
    ).rejects.toThrow(/404/)
  })

  it('ignores requests sent before a hello that proves the token', async () => {
    const { server } = await boot(undefined, { ...defaultGuard(), requireToken: true })
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`)
    await new Promise((resolve) => ws.once('open', resolve))
    cleanup.push(() => ws.terminate())
    const closed = new Promise<number>((resolve) => ws.once('close', resolve))
    ws.send(JSON.stringify({ t: 'req', id: '1', method: 'providers.list', params: {} }))
    expect(await closed).toBe(1008)
  })

  it('pairs a device with a one-time code and the token it gets works', async () => {
    const { server, pairing } = await boot(undefined, { ...defaultGuard(), requireToken: true })
    const { code } = pairing.create()

    const wrong = await pair(server.port, {
      code: code === '000000' ? '000001' : '000000',
      deviceName: 'x',
    })
    expect(wrong.status).toBe(403)

    const res = await pair(server.port, { code, deviceName: 'Laptop' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { token: string; host: { hostId: string } }
    expect(body.host.hostId).toBe('host-1')

    const c = await Client.connect(server.port, { token: body.token })
    await c.until((fs) => fs.some((f) => f.t === 'welcome'))
    expect((await c.rpc('devices.list', {})).ok).toBe(true)

    // The code was single-use.
    expect((await pair(server.port, { code, deviceName: 'Again' })).status).toBe(403)
  })

  it('rejects pairing from a foreign web page, and non-JSON bodies', async () => {
    const { server, pairing } = await boot()
    const { code } = pairing.create()
    const evil = await pair(
      server.port,
      { code, deviceName: 'x' },
      { origin: 'https://evil.example' },
    )
    expect(evil.status).toBe(403)
    const form = await fetch(`http://127.0.0.1:${server.port}/pair`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ code }),
    })
    expect(form.status).toBe(400)
    // Neither attempt used up the code.
    expect((await pair(server.port, { code, deviceName: 'Real' })).status).toBe(200)
  })

  it('issues pairing codes to the local machine only, over RPC and HTTP', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)
    const res = await c.rpc('host.pair', {})
    expect(res.ok && (res.result as { code: string }).code).toMatch(/^\d{6}$/)

    const admin = await fetch(`http://127.0.0.1:${server.port}/admin/pair`, { method: 'POST' })
    expect(admin.status).toBe(200)
    const viaBrowser = await fetch(`http://127.0.0.1:${server.port}/admin/pair`, {
      method: 'POST',
      headers: { origin: 'http://localhost:5173' },
    })
    expect(viaBrowser.status).toBe(403)
  })

  it('lists and revokes devices, and a revoked token stops working', async () => {
    const { server, tokens } = await boot(undefined, { ...defaultGuard(), requireToken: true })
    const { token, device } = tokens.issue('Phone')
    const c = await Client.connect(server.port, { token })
    const { token: otherToken } = tokens.issue('Other device')
    const other = await Client.connect(server.port, { token: otherToken })
    const list = await c.rpc('devices.list', {})
    expect(list.ok && (list.result as { name: string }[])[0]?.name).toBe('Phone')
    const revoked = await other.rpc('devices.revoke', { id: device.id })
    expect(revoked.ok && (revoked.result as { revoked: boolean }).revoked).toBe(true)
    expect(tokens.verify(token)).toBeNull()
    await c.until((frames) => frames.some((f) => f.t === 'denied'))
    expect((await other.rpc('providers.list', {})).ok).toBe(true)
    const again = await Client.connect(server.port, { token })
    await again.until((frames) => frames.some((f) => f.t === 'denied'))
  })

  it('makes peers relayed by a local reverse proxy (Tailscale Serve) pair first', async () => {
    const { server, tokens, pairing } = await boot()
    const relayed = { 'x-forwarded-for': '100.101.1.2', 'tailscale-user-login': 'me@example.com' }
    const anon = await Client.connect(server.port, { headers: relayed })
    await anon.until((fs) => fs.some((f) => f.t === 'denied'))

    // No pairing codes for relayed peers, over HTTP either.
    const admin = await fetch(`http://127.0.0.1:${server.port}/admin/pair`, {
      method: 'POST',
      headers: relayed,
    })
    expect(admin.status).toBe(403)

    // Pairing through the proxy works, and the token gets the relayed peer in.
    const { code } = pairing.create()
    expect((await pair(server.port, { code, deviceName: 'Laptop' }, relayed)).status).toBe(200)
    const { token } = tokens.issue('Laptop')
    const good = await Client.connect(server.port, { token, headers: relayed })
    await good.until((fs) => fs.some((f) => f.t === 'welcome'))
    const pairRpc = await good.rpc('host.pair', {})
    expect(pairRpc.ok).toBe(false)

    // Funnel traffic from the internet is refused outright.
    const funnel = await fetch(`http://127.0.0.1:${server.port}/health`, {
      headers: { 'tailscale-funnel-request': '?1', 'x-forwarded-for': '8.8.8.8' },
    })
    expect(funnel.status).toBe(403)
  })

  it('reports Tailscale as unavailable instead of failing', async () => {
    const { server } = await boot()
    const c = await Client.connect(server.port)
    const res = await c.rpc('tailnet.peers', {})
    expect(res.ok && (res.result as { state: string }).state).toBe('not-installed')
  })
})

describe('multiple hosts through the client runtime', () => {
  it('keeps sessions isolated, replays missed events, and stops a revoked client', async () => {
    const first = await boot(undefined, { ...defaultGuard(), requireToken: true }, 'one')
    const second = await boot(undefined, { ...defaultGuard(), requireToken: true }, 'two')
    const tokenFor = async (host: Awaited<ReturnType<typeof boot>>) => {
      const { code } = host.pairing.create()
      const res = await fetch(`http://127.0.0.1:${host.server.port}/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code, deviceName: 'Workspace' }),
      })
      expect(res.ok).toBe(true)
      return ((await res.json()) as { token: string }).token
    }
    const firstToken = await tokenFor(first)
    const secondToken = await tokenFor(second)
    const connect = (host: Awaited<ReturnType<typeof boot>>, token: string) => {
      let replica = emptyReplica()
      const sockets: WebSocket[] = []
      const client = new HostClient({
        url: `ws://127.0.0.1:${host.server.port}/ws`,
        token,
        expectedHostId: host.server.hostInfo.hostId,
        onEvent: (stored) => {
          replica = applyEvent(replica, stored)
        },
        createSocket: (url) => {
          const socket = new WebSocket(url)
          sockets.push(socket)
          return socket as unknown as globalThis.WebSocket
        },
        heartbeatMs: 25,
        backoff: { minMs: 10, maxMs: 20 },
      })
      cleanup.push(() => client.stop())
      client.start()
      return { client, sockets, replica: () => replica }
    }
    const a = connect(first, firstToken)
    const b = connect(second, secondToken)
    await vi.waitFor(() => {
      expect(a.client.connectionState).toBe('connected')
      expect(b.client.connectionState).toBe('connected')
    })
    const sessionA = await a.client.request('sessions.create', {
      instanceId: 'fake',
      title: 'First host',
      permissionMode: 'full',
    })
    const sessionB = await b.client.request('sessions.create', {
      instanceId: 'fake',
      title: 'Second host',
      permissionMode: 'full',
    })
    await Promise.all([
      a.client.request('sessions.prompt', { ...sessionA, text: 'one' }),
      b.client.request('sessions.prompt', { ...sessionB, text: 'two' }),
    ])
    await vi.waitFor(() => {
      expect(a.replica().sessions[sessionA.sessionId]?.status).toBe('idle')
      expect(b.replica().sessions[sessionB.sessionId]?.status).toBe('idle')
      expect(a.replica().sessions[sessionA.sessionId]?.items.some((i) => i.kind === 'diff')).toBe(
        true,
      )
      expect(b.replica().sessions[sessionB.sessionId]?.items.some((i) => i.kind === 'diff')).toBe(
        true,
      )
    })
    expect(a.replica().order).toEqual([sessionA.sessionId])
    expect(b.replica().order).toEqual([sessionB.sessionId])

    a.sockets.at(-1)!.terminate()
    const missed = first.store.append({
      type: 'error',
      sessionId: sessionA.sessionId,
      at: Date.now(),
      message: 'While disconnected',
    })
    await vi.waitFor(() => expect(a.replica().lastSeq).toBe(missed.seq))
    expect(a.sockets.length).toBeGreaterThan(1)
    expect(
      a
        .replica()
        .sessions[sessionA.sessionId]!.items.filter(
          (i) => i.kind === 'error' && i.message === 'While disconnected',
        ),
    ).toHaveLength(1)
    expect(b.replica().sessions[sessionB.sessionId]?.status).toBe('idle')

    first.tokens.revoke(first.tokens.list()[0]!.id)
    await vi.waitFor(() => expect(a.client.connectionState).toBe('denied'))
    await expect(a.client.request('providers.list', {})).rejects.toThrow('not connected')
    expect((await b.client.request('providers.list', {})).length).toBeGreaterThan(0)
  })
})

/** Talks MCP to the bridge an agent would start for a session, over its stdio. */
function startBridge(server: { command: string; args: string[]; env: Record<string, string> }) {
  const child = spawn(server.command, server.args, {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  cleanup.push(() => void child.kill())
  const pending = new Map<
    number,
    (msg: { result?: unknown; error?: { message: string } }) => void
  >()
  createInterface({ input: child.stdout }).on('line', (line) => {
    const msg = JSON.parse(line) as { id: number; result?: unknown; error?: { message: string } }
    pending.get(msg.id)?.(msg)
  })
  let id = 0
  const request = (method: string, params?: unknown) =>
    new Promise<{ result?: unknown; error?: { message: string } }>((resolve) => {
      pending.set(++id, resolve)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await request('tools/call', { name, arguments: args })
    const result = res.result as { content: { text: string }[]; isError?: boolean }
    const text = result.content[0]!.text
    return result.isError ? { error: text } : (JSON.parse(text) as Record<string, unknown>)
  }
  return { request, tool }
}

describe('automation', () => {
  it('lets a session with agent tools start a child, wait for it, and the user approves it', async () => {
    const { server, store, automation } = await boot()
    const c = await Client.connect(server.port)
    await c.until((fs) => fs.some((f) => f.t === 'welcome'))
    const plain = (await c.rpc('sessions.create', { instanceId: 'fake' })).result as {
      sessionId: string
    }
    expect(automation.agentTools.serversFor(plain.sessionId)).toHaveLength(1)
    const created = await c.rpc('sessions.create', {
      instanceId: 'fake',
      agentTools: true,
      title: 'Lead',
    })
    const { sessionId } = created.result as { sessionId: string }

    const [bridge] = automation.agentTools.serversFor(sessionId)
    const mcp = startBridge(bridge!)
    const init = await mcp.request('initialize', { protocolVersion: '2025-06-18' })
    expect(init.result).toMatchObject({ serverInfo: { name: 'beddcode' } })
    const listed = (await mcp.request('tools/list')).result as { tools: { name: string }[] }
    expect(listed.tools.map((t) => t.name)).toContain('start_session')

    const started = await mcp.tool('start_session', {
      agent: 'fake',
      prompt: 'fix the limiter',
      title: 'Helper',
    })
    expect(started).toMatchObject({ agent: 'fake', mode: 'ask' })
    const childId = started.session_id as string
    // A big call, such as a whole screen of design elements, is not turned away for its size.
    expect(
      await mcp.tool('get_status', { session_id: 'x'.repeat(200_000) }),
    ).not.toMatchObject({ error: expect.stringMatching(/Invalid request/) })
    expect(automation.agentTools.serversFor(childId)).toHaveLength(1)

    const waiting = await mcp.tool('wait_for', { session_id: childId, timeout_seconds: 20 })
    expect(waiting).toMatchObject({ status: 'needs-you', done: false })

    // The user answers the child's approval; the parent's next wait sees it finish.
    const done = mcp.tool('wait_for', { session_id: childId, timeout_seconds: 20 })
    const request = store
      .readSession(childId)
      .map((e) => e.event)
      .find((e) => e.type === 'approval.requested')
    if (request?.type !== 'approval.requested') throw new Error('expected approval request')
    await c.rpc('sessions.approve', {
      sessionId: childId,
      requestId: request.requestId,
      optionId: 'allow',
    })
    expect(await done).toMatchObject({ status: 'idle', done: true })
    expect(await mcp.tool('list_children')).toEqual([
      expect.objectContaining({ session_id: childId }),
    ])
    expect(await mcp.tool('get_status', { session_id: plain.sessionId })).toMatchObject({
      error: expect.stringMatching(/not a session you started/),
    })
    const createdEvent = store.readSession(childId)[0]!.event
    expect(createdEvent.type === 'session.created' && createdEvent.parent).toEqual({
      sessionId,
      depth: 1,
    })
  })

  it('does the work of a repeated request once, as after a reconnect', async () => {
    const { server, store } = await boot()
    const first = await Client.connect(server.port)
    const make = (c: Client, id: string) => {
      c.send({
        t: 'req',
        id,
        rid: 'same-request',
        method: 'sessions.create',
        params: { instanceId: 'fake', permissionMode: 'full', title: 'Once' },
      })
      return c
        .until((fs) => fs.some((f) => f.t === 'res' && f.id === id))
        .then(() => c.frames.find((f) => f.t === 'res' && f.id === id) as Extract<ServerFrame, { t: 'res' }>)
    }
    const a1 = await make(first, 'a')
    first.ws.terminate()
    const second = await Client.connect(server.port)
    const a2 = await make(second, 'b')
    expect(a1.ok && a2.ok).toBe(true)
    expect(a2.result).toEqual(a1.result)
    const created = store.readAfter(0, 100).filter((e) => e.event.type === 'session.created')
    expect(created).toHaveLength(1)
  })

  it('turns away agent-tool calls without the session key', async () => {
    const { server } = await boot()
    const call = (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${server.port}/agent-tools`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ method: 'tools/list' }),
      })
    expect((await call({})).status).toBe(401)
    expect((await call({ authorization: 'Bearer nope' })).status).toBe(401)
    expect(
      (await call({ authorization: 'Bearer nope', origin: 'http://evil.example' })).status,
    ).toBe(403)
  })

  it('pushes alerts to a paired phone, and forgets it when the device is revoked', async () => {
    const { server, tokens, pushes } = await boot(undefined, {
      ...defaultGuard(),
      requireToken: true,
    })
    const { token, device } = tokens.issue('Pixel')
    const phone = await Client.connect(server.port, { token })
    await phone.until((fs) => fs.some((f) => f.t === 'welcome'))
    const registered = await phone.rpc('push.register', {
      token: 'ExponentPushToken[phone-token-1]',
      deviceName: 'Pixel',
      platform: 'android',
      events: { turnDone: true, needsYou: true, error: true, schedule: true },
    })
    expect(registered).toMatchObject({ ok: true })
    const view = await phone.rpc('alerts.settings', {})
    expect(view.result).toMatchObject({ devices: [{ deviceId: device.id, deviceName: 'Pixel' }] })

    const { sessionId } = (
      await phone.rpc('sessions.create', {
        instanceId: 'fake',
        permissionMode: 'full',
        title: 'Ship it',
      })
    ).result as { sessionId: string }
    await phone.rpc('sessions.prompt', { sessionId, text: 'go' })
    await vi.waitFor(() => expect(pushes).toHaveLength(1))
    expect((pushes[0]!.body as unknown[])[0]).toMatchObject({
      to: 'ExponentPushToken[phone-token-1]',
      title: 'Ship it',
      data: { kind: 'turnDone', sessionId, url: `beddcode://session/${sessionId}` },
    })

    tokens.revoke(device.id)
    await phone.until((fs) => fs.some((f) => f.t === 'denied'))
    const { token: other } = tokens.issue('Laptop')
    const laptop = await Client.connect(server.port, { token: other })
    const after = await laptop.rpc('alerts.settings', {})
    expect((after.result as { devices: unknown[] }).devices).toEqual([])
  })

  it('runs a schedule on demand and on its timer, and alerts when it finishes', async () => {
    const { server, pushes } = await boot()
    const c = await Client.connect(server.port)
    await c.until((fs) => fs.some((f) => f.t === 'welcome'))
    await c.rpc('alerts.setSettings', { ntfyUrl: 'https://ntfy.example/topic-1' })
    const saved = await c.rpc('schedules.save', {
      name: 'Nightly',
      prompt: 'check the build',
      trigger: { kind: 'every', minutes: 60 },
      target: { kind: 'new', instanceId: 'fake', permissionMode: 'full' },
    })
    expect(saved).toMatchObject({ ok: true })
    const { id } = saved.result as { id: string }
    const run = await c.rpc('schedules.runNow', { id })
    expect(run.result).toMatchObject({ status: 'running', manual: true })
    await vi.waitFor(async () => {
      const list = (await c.rpc('schedules.list', {})).result as { runs: { status: string }[] }
      expect(list.runs[0]?.status).toBe('done')
    })
    await vi.waitFor(() => expect(pushes).toHaveLength(1))
    expect(pushes[0]).toMatchObject({ body: { topic: 'topic-1', title: 'Scheduled: Nightly' } })
    const preview = await c.rpc('schedules.preview', {
      trigger: { kind: 'cron', expr: '*/15 * * * *' },
    })
    expect((preview.result as { times: number[] }).times).toHaveLength(3)
    expect((await c.rpc('schedules.remove', { id })).ok).toBe(true)
  })
})
