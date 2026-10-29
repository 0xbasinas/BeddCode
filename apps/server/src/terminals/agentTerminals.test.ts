import { afterEach, describe, expect, it } from 'vitest'
import type { SessionEvent, TerminalInfo } from '@beddcode/contracts'
import {
  AgentTerminals,
  MIRROR_OUTPUT_CHARS,
  agentText,
  commandLine,
  displayCommand,
} from './agentTerminals.ts'
import { TerminalManager, type PtyFactory, type PtyProcess, type TerminalFrame } from './manager.ts'

const managers: TerminalManager[] = []
afterEach(() => managers.splice(0).forEach((m) => m.shutdown()))

/** Ptys that record what they were asked to run and can be fed output and an exit by the test. */
function fakePtys() {
  const spawned: {
    file: string
    args: string[]
    cwd: string
    env: Record<string, string>
    emit(d: string): void
    exit(code: number, signal?: number): void
    writes: string[]
    killed: number
  }[] = []
  const factory: PtyFactory = (file, args, options) => {
    const data = new Set<(d: string) => void>()
    const exits = new Set<(e: { exitCode: number; signal?: number }) => void>()
    const record = {
      file,
      args,
      cwd: options.cwd,
      env: options.env,
      writes: [] as string[],
      killed: 0,
      emit: (d: string) => data.forEach((l) => l(d)),
      exit: (code: number, signal?: number) =>
        exits.forEach((l) => l({ exitCode: code, ...(signal ? { signal } : {}) })),
    }
    spawned.push(record)
    const pty: PtyProcess = {
      pid: spawned.length,
      onData: (l) => void data.add(l),
      onExit: (l) => void exits.add(l),
      write: (d) => void record.writes.push(d),
      resize: () => {},
      kill: () => {
        record.killed++
        record.exit(0, 15)
      },
      pause: () => {},
      resume: () => {},
    }
    return pty
  }
  return { factory, spawned }
}

function setup(hostsCommands: boolean) {
  const ptys = fakePtys()
  const terminals = new TerminalManager({ pty: ptys.factory, env: { PATH: '/usr/bin' } })
  managers.push(terminals)
  const changes: { id: string; terminal: TerminalInfo | null }[] = []
  terminals.onChange((c) => changes.push(c))
  const agents = new AgentTerminals(terminals, { platform: 'linux' })
  const host = agents.register({
    sessionId: 's1',
    cwd: '/repo',
    label: hostsCommands ? 'Grok' : 'Claude Code',
    instanceId: hostsCommands ? 'acp:grok' : 'claude',
    title: 'Fix the tests',
    hostsCommands,
  })
  /** Everything the agent terminal has shown, after its output batch is flushed. */
  const screen = () => {
    const [t] = terminals.list()
    if (!t) return ''
    const frames: TerminalFrame[] = []
    terminals.attach(t.id, { send: (f) => frames.push(f), backlog: () => 0 })()
    return frames.map((f) => (f.t === 'term.out' ? f.data : '')).join('')
  }
  return { ptys, terminals, agents, host, changes, screen }
}

const base = { sessionId: 's1', seq: 0, at: 0 }
const ev = (e: Record<string, unknown>) => ({ ...base, ...e }) as unknown as SessionEvent

describe('AgentTerminals: commands an ACP agent runs here', () => {
  it('runs the command in a pty shown in one read-only tab per session', async () => {
    const { ptys, terminals, host, screen, changes } = setup(true)
    const cmd = host.run({
      command: "/usr/bin/bash -lc 'echo hi'",
      cwd: '/repo',
      env: { CI: 'true' },
    })
    const [t] = terminals.list()
    expect(t).toMatchObject({
      cwd: '/repo',
      readOnly: true,
      title: 'Grok · Fix the tests',
      agent: { sessionId: 's1', label: 'Grok', mode: 'pty', running: 'echo hi' },
    })
    // A whole command line goes through a shell, with the agent's environment added.
    expect(ptys.spawned[0]).toMatchObject({ file: '/bin/sh', cwd: '/repo' })
    expect(ptys.spawned[0]!.args).toEqual(['-c', "/usr/bin/bash -lc 'echo hi'"])
    expect(ptys.spawned[0]!.env).toMatchObject({
      CI: 'true',
      PATH: '/usr/bin',
      TERM: 'xterm-256color',
    })

    ptys.spawned[0]!.emit('\x1b[32mhi\x1b[0m\r\n')
    ptys.spawned[0]!.exit(0)
    await expect(cmd.waitForExit()).resolves.toEqual({ exitCode: 0, signal: null })
    expect(cmd.output()).toEqual({
      output: 'hi\n',
      truncated: false,
      exitStatus: { exitCode: 0, signal: null },
    })
    expect(screen()).toContain('echo hi')
    expect(screen()).toContain('\x1b[32mhi')
    // The running indicator came and went.
    expect(changes.some((c) => c.terminal?.agent?.running === 'echo hi')).toBe(true)
    expect(terminals.list()[0]!.agent?.running).toBeUndefined()

    // The next command reuses the tab.
    host.run({ command: 'ls', cwd: '/repo' })
    expect(terminals.list()).toHaveLength(1)
  })

  it('shows commands run at the same time one after another', async () => {
    const { ptys, terminals, host, screen } = setup(true)
    const a = host.run({ command: 'ls', cwd: '/repo' })
    const b = host.run({ command: 'echo hi', cwd: '/repo' })
    ptys.spawned[1]!.emit('hi\r\n')
    ptys.spawned[0]!.emit('a.ts\r\n')
    // Typing goes to the command on screen.
    const id = terminals.list()[0]!.id
    terminals.takeOver(id)
    terminals.write(id, 'x')
    expect(ptys.spawned[0]!.writes).toEqual(['x'])
    ptys.spawned[1]!.exit(0)
    await b.waitForExit()
    expect(b.output().output).toBe('hi\n')
    expect(screen()).not.toContain('echo hi')
    ptys.spawned[0]!.exit(0)
    await a.waitForExit()
    const text = screen().replaceAll(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '')
    expect(text).toBe('$ ls\r\na.ts\r\n\r\n$ echo hi\r\nhi\r\n\r\n')
  })

  it('shows nothing more once the session has ended', () => {
    const { terminals, agents, host } = setup(true)
    host.run({ command: 'ls', cwd: '/repo' })
    agents.ended('s1')
    expect(terminals.list()).toHaveLength(1)
  })

  it('reports a failing command and keeps only the end of long output', async () => {
    const { ptys, host, screen } = setup(true)
    const cmd = host.run({ command: 'make', args: ['test'], cwd: '/repo', outputByteLimit: 10 })
    ptys.spawned[0]!.emit('0123456789abcdef')
    ptys.spawned[0]!.exit(2)
    await cmd.waitForExit()
    expect(cmd.output()).toMatchObject({ output: '6789abcdef', truncated: true })
    expect(screen()).toContain('[exit 2]')
  })

  it('stops the command on kill and release', async () => {
    const { ptys, host } = setup(true)
    const cmd = host.run({ command: 'sleep 100', cwd: '/repo' })
    cmd.kill()
    expect(ptys.spawned[0]!.killed).toBe(1)
    await expect(cmd.waitForExit()).resolves.toEqual({ exitCode: null, signal: 'signal 15' })
    cmd.release()
    expect(ptys.spawned[0]!.killed).toBe(1)
  })

  it('ignores typing until taken over, then sends it to the running command', () => {
    const { ptys, terminals, host } = setup(true)
    host.run({ command: 'read x', cwd: '/repo' })
    const id = terminals.list()[0]!.id
    terminals.write(id, 'nope\r')
    expect(ptys.spawned[0]!.writes).toEqual([])
    expect(terminals.takeOver(id).readOnly).toBeUndefined()
    terminals.write(id, 'yes\r')
    expect(ptys.spawned[0]!.writes).toEqual(['yes\r'])
  })

  it('does not mirror a command tool call that ran in the pty', () => {
    const { ptys, agents, host, screen } = setup(true)
    agents.observe(
      ev({ type: 'tool.started', toolId: 't1', kind: 'command', name: 'bash', command: 'echo hi' }),
    )
    // Not shown yet: an ACP agent may still run it here.
    expect(screen()).toBe('')
    host.run({ command: "bash -lc 'echo hi'", cwd: '/repo' })
    ptys.spawned[0]!.emit('hi\r\n')
    ptys.spawned[0]!.exit(0)
    agents.observe(ev({ type: 'tool.completed', toolId: 't1', ok: true, output: 'hi' }))
    expect(screen().match(/echo hi/g)).toHaveLength(1)
    expect(screen().match(/hi\r\n/g)).toHaveLength(1)
  })

  it('mirrors a command an ACP agent ran itself', () => {
    const { agents, screen } = setup(true)
    agents.observe(
      ev({ type: 'tool.started', toolId: 't1', kind: 'command', name: 'bash', command: 'pwd' }),
    )
    agents.observe(ev({ type: 'tool.completed', toolId: 't1', ok: true, output: '/repo' }))
    expect(screen()).toContain('pwd')
    expect(screen()).toContain('/repo')
  })

  it('ends the tab with the session', () => {
    const { terminals, agents, host, ptys } = setup(true)
    host.run({ command: 'sleep 100', cwd: '/repo' })
    agents.ended('s1')
    expect(ptys.spawned[0]!.killed).toBe(1)
    expect(terminals.list()[0]!.exited).toBe(0)
    expect(() => host.run({ command: 'ls', cwd: '/repo' })).toThrow('ended')
  })
})

describe('AgentTerminals: mirrored commands (Claude Code, Codex)', () => {
  it('shows the command at once and streams its output', () => {
    const { agents, terminals, screen } = setup(false)
    agents.observe(
      ev({ type: 'tool.started', toolId: 't1', kind: 'command', name: 'Bash', command: 'ls' }),
    )
    expect(terminals.list()[0]).toMatchObject({ agent: { mode: 'mirror', running: 'ls' } })
    agents.observe(ev({ type: 'tool.output', toolId: 't1', data: 'a.ts\nb.ts\n' }))
    agents.observe(ev({ type: 'tool.completed', toolId: 't1', ok: true, output: 'a.ts\nb.ts' }))
    const text = screen()
    expect(text).toContain('ls')
    expect(text).toContain('a.ts\r\nb.ts\r\n')
    // Streamed output is not written again from the result.
    expect(text.match(/a\.ts/g)).toHaveLength(1)
    expect(terminals.list()[0]!.agent?.running).toBeUndefined()
  })

  it('keeps output that arrives before its command is announced', () => {
    const { agents, screen } = setup(false)
    agents.observe(ev({ type: 'tool.output', toolId: 't1', data: 'step 1\n' }))
    agents.observe(
      ev({ type: 'tool.started', toolId: 't1', kind: 'command', name: 'Bash', command: 'run' }),
    )
    agents.observe(ev({ type: 'tool.output', toolId: 't1', data: 'step 2\n' }))
    agents.observe(ev({ type: 'tool.completed', toolId: 't1', ok: true, output: 'step 1\nstep 2' }))
    expect(screen()).toContain('step 1\r\nstep 2\r\n')
    expect(screen().match(/step 1/g)).toHaveLength(1)
  })

  it('writes the result when nothing was streamed, and marks a failure', () => {
    const { agents, screen } = setup(false)
    agents.observe(
      ev({
        type: 'tool.started',
        toolId: 't1',
        kind: 'command',
        name: 'Bash',
        input: '{"command":"false"}',
      }),
    )
    agents.observe(ev({ type: 'tool.completed', toolId: 't1', ok: false, output: 'boom' }))
    expect(screen()).toContain('false')
    expect(screen()).toContain('boom')
    expect(screen()).toContain('[failed]')
  })

  it('caps the output of one command', () => {
    const { agents, screen } = setup(false)
    agents.observe(
      ev({ type: 'tool.started', toolId: 't1', kind: 'command', name: 'Bash', command: 'yes' }),
    )
    agents.observe(
      ev({ type: 'tool.output', toolId: 't1', data: 'y'.repeat(MIRROR_OUTPUT_CHARS + 500) }),
    )
    // The command's own `y` and the cut-off output.
    expect(screen().split('y').length - 1).toBe(MIRROR_OUTPUT_CHARS + 1)
    expect(screen()).toContain('output cut off')
  })

  it('leaves other tools alone', () => {
    const { agents, terminals } = setup(false)
    agents.observe(
      ev({ type: 'tool.started', toolId: 't1', kind: 'read', name: 'Read', input: '{}' }),
    )
    expect(terminals.list()).toEqual([])
  })

  it('opens a new tab after the user closed it', () => {
    const { agents, terminals } = setup(false)
    agents.observe(
      ev({ type: 'tool.started', toolId: 't1', kind: 'command', name: 'Bash', command: 'ls' }),
    )
    terminals.close(terminals.list()[0]!.id)
    agents.observe(
      ev({ type: 'tool.started', toolId: 't2', kind: 'command', name: 'Bash', command: 'pwd' }),
    )
    expect(terminals.list()).toHaveLength(1)
  })
})

describe('helpers', () => {
  it('shows the script a shell wrapper runs', () => {
    expect(displayCommand("/usr/bin/bash -lc 'echo hi'")).toBe('echo hi')
    expect(displayCommand('/usr/bin/bash -lc ls')).toBe('ls')
    expect(displayCommand('bash', ['-c', 'npm test'])).toBe('npm test')
    expect(displayCommand('git', ['status', '--short'])).toBe('git status --short')
  })

  it('builds the command line per platform', () => {
    expect(commandLine('echo hi && ls', [], 'linux')).toEqual({
      file: '/bin/sh',
      args: ['-c', 'echo hi && ls'],
    })
    const win = commandLine('dir /b', [], 'win32')
    expect(win.file.toLowerCase()).toContain('cmd')
    expect(win.args.join(' ')).toContain('dir /b')
  })

  it('strips colours and carriage returns from what the agent reads', () => {
    expect(agentText('\x1b[1;31merror\x1b[0m\r\n')).toBe('error\n')
  })
})
