import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TerminalManager,
  defaultShell,
  type PtyFactory,
  type PtyProcess,
  type TerminalFrame,
  type TerminalSubscriber,
} from './manager.ts'

const managers: TerminalManager[] = []
const dirs: string[] = []
afterEach(async () => {
  managers.splice(0).forEach((m) => m.shutdown())
  // A killed shell can still hold its folder for a moment on Windows.
  await new Promise((r) => setTimeout(r, 300))
  dirs
    .splice(0)
    .forEach((d) => rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 150 }))
})
const track = (m: TerminalManager) => (managers.push(m), m)
const tmp = () => {
  const d = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-term-')))
  dirs.push(d)
  return d
}

class Collector implements TerminalSubscriber {
  frames: TerminalFrame[] = []
  queued = 0
  send(frame: TerminalFrame) {
    this.frames.push(frame)
  }
  backlog() {
    return this.queued
  }
  text() {
    return this.frames.map((f) => (f.t === 'term.out' ? f.data : '')).join('')
  }
  exit() {
    return this.frames.find((f) => f.t === 'term.exit')
  }
}

async function until(pred: () => boolean, ms = 8000) {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 20))
  }
}

/** A "shell" that is just a node script, so tests do not depend on the user's shell. */
const node = (script: string) => ({ file: process.execPath, args: ['-e', script], name: 'node' })

describe('TerminalManager (real pty)', () => {
  it('runs a command in the folder and reports its output and exit code', async () => {
    const m = track(new TerminalManager())
    const cwd = tmp()
    const info = m.create({
      cwd,
      shell: node('console.log("cwd=" + process.cwd()); process.exit(3)'),
    })
    expect(info).toMatchObject({ cwd, shell: 'node', cols: 80, rows: 24 })

    const c = new Collector()
    m.attach(info.id, c)
    await until(() => c.exit() !== undefined)
    expect(c.text()).toContain(`cwd=${cwd}`)
    expect(c.exit()).toMatchObject({ code: 3 })
    expect(m.list(cwd)[0]?.exited).toBe(3)
  })

  it('passes keyboard input to the shell', async () => {
    const m = track(new TerminalManager())
    const info = m.create({
      cwd: tmp(),
      shell: node(
        'process.stdin.setEncoding("utf8"); process.stdin.on("data", d => { console.log("GOT:" + d.trim().toUpperCase()); process.exit(0) })',
      ),
    })
    const c = new Collector()
    m.attach(info.id, c)
    m.write(info.id, 'hello\r\n')
    await until(() => c.text().includes('GOT:HELLO'))
  })

  it('replays history to a client that attaches later', async () => {
    const m = track(new TerminalManager())
    const info = m.create({
      cwd: tmp(),
      shell: node('console.log("early output"); setInterval(() => {}, 1000)'),
    })
    const first = new Collector()
    m.attach(info.id, first)
    await until(() => first.text().includes('early output'))

    const late = new Collector()
    m.attach(info.id, late)
    expect(late.frames[0]).toMatchObject({ t: 'term.out', replay: true })
    expect(late.text()).toContain('early output')
  })

  it('keeps only the tail of very long output', async () => {
    const m = track(new TerminalManager())
    const info = m.create({
      cwd: tmp(),
      // Let Node drain stdout before exiting; process.exit() can truncate queued PTY output.
      shell: node('process.stdout.write("A".repeat(400000) + "END-MARKER")'),
    })
    const c = new Collector()
    m.attach(info.id, c)
    await until(() => c.exit() !== undefined)

    const late = new Collector()
    m.attach(info.id, late)
    const history = late.text()
    expect(history.length).toBeLessThanOrEqual(200_000 + 20)
    expect(history).toContain('END-MARKER')
  })

  it('records resizes and ignores input after the shell has exited', async () => {
    const m = track(new TerminalManager())
    const info = m.create({ cwd: tmp(), shell: node('setInterval(() => {}, 1000)') })
    m.resize(info.id, 120, 40)
    expect(m.list()[0]).toMatchObject({ cols: 120, rows: 40 })

    expect(m.close(info.id)).toBe(true)
    expect(m.list()).toEqual([])
    expect(m.close(info.id)).toBe(false)
    m.write(info.id, 'ignored') // must not throw
  })

  it('lists terminals per folder', () => {
    const m = track(new TerminalManager())
    const a = tmp()
    const b = tmp()
    m.create({ cwd: a, shell: node('setInterval(() => {}, 1000)') })
    m.create({ cwd: b, shell: node('setInterval(() => {}, 1000)') })
    expect(m.list(a)).toHaveLength(1)
    expect(m.list()).toHaveLength(2)
  })

  it('refuses to attach to an unknown terminal', () => {
    expect(() => track(new TerminalManager()).attach('nope', new Collector())).toThrow(
      'Unknown terminal',
    )
  })
})

/** A scriptable pty so batching and flow control can be tested without real shells. */
function fakePty() {
  let onData: (d: string) => void = () => {}
  let onExit: (e: { exitCode: number }) => void = () => {}
  const calls = { pause: 0, resume: 0, kill: 0, writes: [] as string[] }
  const pty: PtyProcess = {
    pid: 1,
    onData: (l) => (onData = l),
    onExit: (l) => (onExit = l),
    write: (d) => calls.writes.push(d),
    resize: () => {},
    kill: () => {
      calls.kill++
    },
    pause: () => {
      calls.pause++
    },
    resume: () => {
      calls.resume++
    },
  }
  const factory: PtyFactory = () => pty
  return {
    factory,
    calls,
    emit: (d: string) => onData(d),
    exit: (code: number) => onExit({ exitCode: code }),
  }
}

describe('TerminalManager (output handling)', () => {
  it('batches rapid output into one frame', async () => {
    const f = fakePty()
    const m = track(new TerminalManager({ pty: f.factory }))
    const info = m.create({ cwd: '/x', shell: node('') })
    const c = new Collector()
    m.attach(info.id, c)

    for (let i = 0; i < 50; i++) f.emit(`line ${i}\n`)
    expect(c.frames).toHaveLength(0)
    await until(() => c.frames.length > 0)
    expect(c.frames).toHaveLength(1)
    expect(c.text()).toContain('line 0')
    expect(c.text()).toContain('line 49')
  })

  it('flushes immediately once a batch is large', () => {
    const f = fakePty()
    const m = track(new TerminalManager({ pty: f.factory }))
    const info = m.create({ cwd: '/x', shell: node('') })
    const c = new Collector()
    m.attach(info.id, c)
    f.emit('x'.repeat(40_000))
    expect(c.frames).toHaveLength(1)
  })

  it('pauses the shell while a client is far behind and resumes when it catches up', async () => {
    const f = fakePty()
    const m = track(new TerminalManager({ pty: f.factory }))
    const info = m.create({ cwd: '/x', shell: node('') })
    const slow = new Collector()
    m.attach(info.id, slow)

    slow.queued = 2_000_000
    f.emit('y'.repeat(40_000))
    expect(f.calls.pause).toBe(1)

    f.emit('y'.repeat(40_000)) // already paused: no second pause
    expect(f.calls.pause).toBe(1)

    slow.queued = 0
    await until(() => f.calls.resume === 1)
  })

  it('resumes the shell when the slow client disconnects', async () => {
    const f = fakePty()
    const m = track(new TerminalManager({ pty: f.factory }))
    const info = m.create({ cwd: '/x', shell: node('') })
    const slow = new Collector()
    const detach = m.attach(info.id, slow)
    slow.queued = 5_000_000
    f.emit('z'.repeat(40_000))
    expect(f.calls.pause).toBe(1)
    detach()
    await until(() => f.calls.resume === 1)
  })

  it('does not drop output for an existing client when another one attaches', async () => {
    const f = fakePty()
    const m = track(new TerminalManager({ pty: f.factory }))
    const info = m.create({ cwd: '/x', shell: node('') })
    const first = new Collector()
    m.attach(info.id, first)
    f.emit('before-attach')

    const second = new Collector()
    m.attach(info.id, second)
    expect(first.text()).toBe('before-attach')
    expect(second.text()).toBe('before-attach')
    expect(second.frames[0]).toMatchObject({ replay: true })

    f.emit('after')
    await until(() => first.text().endsWith('after') && second.text().endsWith('after'))
  })

  it('kills the shell when the terminal is closed and tells subscribers', () => {
    const f = fakePty()
    const m = track(new TerminalManager({ pty: f.factory }))
    const info = m.create({ cwd: '/x', shell: node('') })
    const c = new Collector()
    m.attach(info.id, c)
    m.close(info.id)
    expect(f.calls.kill).toBe(1)
    expect(c.exit()).toMatchObject({ t: 'term.exit' })
  })
})

describe('defaultShell', () => {
  it('prefers PowerShell 7, then Windows PowerShell, then cmd on Windows', () => {
    const only = (names: Record<string, string>) => (n: string) => names[n] ?? null
    expect(
      defaultShell(
        {},
        'win32',
        only({ pwsh: 'C:\\p\\pwsh.exe', powershell: 'C:\\w\\powershell.exe' }),
      ),
    ).toEqual({
      file: 'C:\\p\\pwsh.exe',
      args: ['-NoLogo'],
      name: 'pwsh',
    })
    expect(defaultShell({}, 'win32', only({ powershell: 'C:\\w\\powershell.exe' })).name).toBe(
      'powershell',
    )
    expect(defaultShell({ COMSPEC: 'C:\\Windows\\cmd.exe' }, 'win32', () => null)).toMatchObject({
      name: 'cmd',
    })
  })

  it('uses $SHELL on POSIX, falling back to bash then sh', () => {
    expect(defaultShell({ SHELL: '/usr/bin/zsh' }, 'linux', () => null)).toMatchObject({
      file: '/usr/bin/zsh',
      name: 'zsh',
    })
    expect(defaultShell({}, 'linux', (n) => (n === 'bash' ? '/bin/bash' : null)).name).toBe('bash')
    expect(defaultShell({}, 'linux', () => null)).toMatchObject({ file: '/bin/sh', name: 'sh' })
  })
})

describe('TerminalManager (script runs and ended terminals)', () => {
  /** Every terminal gets its own fake pty; `exit(i)` ends the i-th one. */
  function ptys() {
    const made: { exit(code: number): void; killed: boolean; writes: string[] }[] = []
    const factory: PtyFactory = () => {
      let onExit: (e: { exitCode: number }) => void = () => {}
      const rec = {
        exit: (code: number) => onExit({ exitCode: code }),
        killed: false,
        writes: [] as string[],
      }
      made.push(rec)
      return {
        pid: made.length,
        onData: () => {},
        onExit: (l) => (onExit = l),
        write: (d) => rec.writes.push(d),
        resize: () => {},
        kill: () => {
          rec.killed = true
        },
        pause: () => {},
        resume: () => {},
      }
    }
    return { factory, made }
  }

  it('replaces the earlier terminal of a script run again in the same folder', () => {
    const p = ptys()
    const m = track(new TerminalManager({ pty: p.factory }))
    const plain = m.create({ cwd: '/x', shell: node('') })
    const first = m.create({
      cwd: '/x',
      shell: node(''),
      command: 'npm test',
      title: 'Test',
      scriptId: 'test',
    })
    const elsewhere = m.create({
      cwd: '/y',
      shell: node(''),
      command: 'npm test',
      scriptId: 'test',
    })
    const watcher = new Collector()
    m.attach(first.id, watcher)
    const again = m.create({
      cwd: '/x',
      shell: node(''),
      command: 'npm test',
      title: 'Test',
      scriptId: 'test',
    })
    expect(again.scriptId).toBe('test')
    expect(p.made[1]!.killed).toBe(true)
    expect(watcher.frames.at(-1)).toMatchObject({ t: 'term.exit', id: first.id })
    expect(m.list().map((t) => t.id)).toEqual([plain.id, elsewhere.id, again.id])
    expect(p.made[3]!.writes).toEqual(['npm test\r'])
  })

  it('forgets the oldest ended terminals past the limit, never running ones', () => {
    const p = ptys()
    const m = track(new TerminalManager({ pty: p.factory, maxExited: 2 }))
    const ids = Array.from({ length: 5 }, () => m.create({ cwd: '/x', shell: node('') }).id)
    p.made[0]!.exit(0)
    p.made[2]!.exit(1)
    expect(m.list()).toHaveLength(5)
    p.made[3]!.exit(0)
    expect(m.list().map((t) => t.id)).toEqual([ids[1], ids[2], ids[3], ids[4]])
  })

  it('renames a tab, announces it, and an empty name goes back to the default', () => {
    const p = ptys()
    const m = track(new TerminalManager({ pty: p.factory }))
    const changes: (string | undefined)[] = []
    m.onChange((c) => changes.push(c.terminal?.name))
    const t = m.create({ cwd: '/x', shell: node(''), title: 'dev' })
    expect(m.rename(t.id, '  api server  ').name).toBe('api server')
    expect(m.list()[0]!.name).toBe('api server')
    expect(m.list()[0]!.title).toBe('dev')
    expect(m.rename(t.id, 'x'.repeat(100)).name).toHaveLength(40)
    expect(m.rename(t.id, '   ').name).toBeUndefined()
    expect(changes).toEqual([undefined, 'api server', 'x'.repeat(40), undefined])
    expect(() => m.rename('nope', 'a')).toThrow()
  })
})
