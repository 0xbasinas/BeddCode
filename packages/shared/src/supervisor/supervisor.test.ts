import { afterAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { Connection } from './client.ts'
import { alive, scratch, until } from './testing/harness.ts'

describe('what the supervisor acknowledges', () => {
  const s = scratch('codex', { FAKE_PARTS: '3', FAKE_TICK_MS: '50' })
  afterAll(() => s.cleanup())

  const readAll = (proc: { stdout: NodeJS.ReadableStream }) => {
    let data = ''
    proc.stdout.on('data', (c) => (data += String(c)))
    return () => data
  }
  const prompt = JSON.stringify({ id: 5, method: 'turn/start', params: {} }) + '\n'

  it('rejects a duplicate spawn without killing the live agent', async () => {
    const original = s.host().spawn('duplicate', s.spec, {})
    await until(() => original.pid > 0)
    const pid = original.pid
    const duplicate = s.host().spawn('duplicate', s.spec, {})
    const errors: string[] = []
    duplicate.on('error', (error: Error) => errors.push(error.message))
    await until(() => errors.length > 0)
    expect(errors[0]).toContain('already running')
    expect(alive(pid)).toBe(true)
    expect((await s.host().list()).find((agent) => agent.id === 'duplicate')?.pid).toBe(pid)
    original.kill()
  })

  it('ignores commands from an owner superseded by another connection', async () => {
    const original = s.host().spawn('fenced', s.spec, {})
    await until(() => original.pid > 0)
    const pid = original.pid
    const info = JSON.parse(
      readFileSync(path.join(s.root, 'supervisor', 'supervisor.json'), 'utf8'),
    ) as {
      endpoint: string
      token: string
    }
    const connect = async () => {
      const socket = net.createConnection({ path: info.endpoint, allowHalfOpen: true })
      const connection = new Connection(socket)
      const hello = connection.next((frame) => frame.op === 'hello')
      connection.send({ op: 'hello', token: info.token })
      await hello
      return connection
    }
    const old = await connect()
    const attachedOld = old.next((frame) => frame.op === 'attached')
    old.send({ op: 'attach', id: 'fenced' })
    await attachedOld
    const current = await connect()
    const attachedCurrent = current.next((frame) => frame.op === 'attached')
    current.send({ op: 'attach', id: 'fenced' })
    await attachedCurrent
    old.send({ op: 'kill' })
    old.send({ op: 'meta', meta: { stale: true } })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(alive(pid)).toBe(true)
    expect((await s.host().list()).find((agent) => agent.id === 'fenced')?.meta).not.toMatchObject({
      stale: true,
    })
    current.send({ op: 'kill' })
    old.socket.destroy()
    current.close()
  })

  it('does not acknowledge what the session has not processed, so a crash loses nothing', async () => {
    const proc = s.host().spawn('a', s.spec, {})
    proc.ackGate = () => false // the session never got to process it
    const got = readAll(proc)
    proc.stdin.write(prompt)
    await until(() => got().includes('part 3;'))
    // The host dies without a goodbye.
    ;(proc as unknown as { conn: { socket: { destroy(): void } } }).conn.socket.destroy()
    await new Promise((r) => setTimeout(r, 300))

    const again = await s.host().attach('a')
    const replayed = readAll(again!)
    await until(() => replayed().includes('part 3;'))
    expect(replayed()).toContain('part 1;') // everything was kept, since none of it was acknowledged
    again!.detach()
  })

  it('acknowledges what was processed, once it is a moment old, so a later host gets only the rest', async () => {
    const proc = s.host().spawn('b', s.spec, {})
    const got = readAll(proc)
    proc.stdin.write(prompt)
    await until(() => got().includes('part 3;'))
    await new Promise((r) => setTimeout(r, 600))
    const [info] = (await s.host().list()).filter((a) => a.id === 'b')
    expect(info?.acked).toBeGreaterThan(0)
    expect(info?.acked).toBe(info?.size)
    proc.detach()
    const again = await s.host().attach('b')
    const replayed = readAll(again!)
    await new Promise((r) => setTimeout(r, 300))
    expect(replayed()).not.toContain('part 1;')
    again!.kill()
    await until(() => !alive(info!.pid))
  })
})

describe('a session that handles each line as it arrives', () => {
  const s = scratch('codex', { FAKE_PARTS: '3', FAKE_TICK_MS: '50' })
  afterAll(() => s.cleanup())

  it('acknowledges within the same moment, so a crash can repeat next to nothing', async () => {
    const proc = s.host().spawn('c', s.spec, {})
    proc.ackDelayMs = 0
    proc.stdout.on('data', () => {})
    proc.stdin.write(JSON.stringify({ id: 5, method: 'turn/start', params: {} }) + '\n')
    await new Promise((r) => setTimeout(r, 700)) // the fake finishes its three parts by then
    const info = (await s.host().list()).find((a) => a.id === 'c')
    expect(info?.acked).toBe(info?.size)
    proc.kill()
  })
})

describe('agents whose host never comes back', () => {
  const s = scratch(
    'codex',
    { FAKE_PARTS: '1' },
    { BEDDCODE_SUPERVISOR_IDLE_GRACE_MS: '700', BEDDCODE_SUPERVISOR_ACTIVE_GRACE_MS: '60000' },
  )
  afterAll(() => s.cleanup())

  it('ends an idle one soon and keeps one that was mid-turn much longer', async () => {
    const idle = s.host().spawn('idle', s.spec, { active: false })
    const busy = s.host().spawn('busy', s.spec, { active: true })
    await until(() => idle.pid > 0 && busy.pid > 0)
    const idlePid = idle.pid
    idle.detach()
    busy.detach()
    await until(() => !alive(idlePid), 8_000)
    const agents = await s.host().list()
    expect(agents.find((a) => a.id === 'busy')).toMatchObject({ alive: true })
    expect(agents.find((a) => a.id === 'idle')?.alive).not.toBe(true)
  }, 20_000)
})
