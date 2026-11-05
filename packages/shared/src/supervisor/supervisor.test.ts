import { afterAll, describe, expect, it } from 'vitest'
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
