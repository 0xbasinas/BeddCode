import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Schedule, ScheduleRun } from '@beddcode/contracts'
import { LinearSync } from './linearSync.ts'
import { LinearKeyStore } from './linearTools.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const schedule = { id: 's', name: 'Nightly audit' } as Schedule
const failed = {
  id: 'r',
  scheduleId: 's',
  startedAt: 0,
  status: 'error',
  note: 'boom',
} as ScheduleRun

function setup(key: string | null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-lsync-'))
  dirs.push(dir)
  const keys = new LinearKeyStore(path.join(dir, 'linear.json'))
  keys.set(key)
  const calls: { headers: Record<string, string>; body: string }[] = []
  const make = () =>
    new LinearSync(path.join(dir, 'sync.json'), keys, async (_url, init) => {
      calls.push(init)
      return { ok: true, status: 200, json: async () => ({}) }
    })
  return { make, calls }
}

describe('LinearSync', () => {
  it('files an issue for a failed run once it is switched on, and remembers the setting', async () => {
    const t = setup('lin_api_x')
    const sync = t.make()
    await sync.onRunEnded(failed, schedule)
    expect(t.calls).toHaveLength(0)

    sync.set({ fileFailedRuns: true, teamId: 'team-1' })
    await sync.onRunEnded({ ...failed, status: 'done' }, schedule)
    expect(t.calls).toHaveLength(0)
    await sync.onRunEnded(failed, schedule)
    expect(t.calls).toHaveLength(1)
    expect(t.calls[0]!.headers.authorization).toBe('lin_api_x')
    expect(JSON.parse(t.calls[0]!.body).variables.input).toMatchObject({
      teamId: 'team-1',
      title: 'Scheduled task failed: Nightly audit',
    })
    expect(t.make().get()).toEqual({ fileFailedRuns: true, teamId: 'team-1' })
  })

  it('does nothing without a connected key or a team', async () => {
    const t = setup(null)
    const sync = t.make()
    sync.set({ fileFailedRuns: true, teamId: 'team-1' })
    await sync.onRunEnded(failed, schedule)
    expect(t.calls).toHaveLength(0)
  })
})
