import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createLogger } from '@beddcode/shared'
import { AttachmentStore } from './attachments/store.ts'
import { garbageCollect } from './housekeeping.ts'
import { EventStore } from './store/eventStore.ts'

const dirs: string[] = []
const stores: EventStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }))
})

const NOW = new Date('2026-11-09T12:00:00Z').getTime()
const DAY = 86_400_000

function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-gc-'))
  dirs.push(dir)
  const store = new EventStore(path.join(dir, 'beddcode.db'), createLogger('test', 'error'))
  stores.push(store)
  const attachments = new AttachmentStore(path.join(dir, 'attachments'))
  const deleted: string[] = []
  const worktreesRemoved: string[] = []
  const sessions = {
    async delete(id: string) {
      deleted.push(id)
      const { seq } = store.append({ type: 'session.deleted', sessionId: id, at: NOW })
      store.purgeSession(id, seq)
    },
    async removeWorktree(id: string) {
      worktreesRemoved.push(id)
      // Like the real one: the worktree's folder goes away.
      const created = store.readSession(id).find((s) => s.event.type === 'session.created')?.event
      if (created?.type === 'session.created' && created.worktree)
        rmSync(path.resolve(created.cwd), { recursive: true, force: true })
      return true
    },
  }
  const gitRemoved: string[] = []
  const deps = {
    store,
    sessions,
    attachments,
    projects: async () => [{ path: path.join(dir, 'proj') }],
    git: {
      async removeWorktree(p: string) {
        gitRemoved.push(p)
        return true
      },
    },
    log: createLogger('test', 'error'),
    now: () => NOW,
  }
  return { dir, store, attachments, deleted, worktreesRemoved, gitRemoved, deps }
}

const created = (sessionId: string, at: number, extra: Record<string, unknown> = {}) =>
  ({
    type: 'session.created',
    sessionId,
    at,
    title: `t-${sessionId}`,
    cwd: '/w',
    instanceId: 'claude',
    ...extra,
  }) as const

describe('garbageCollect', () => {
  it('removes quiet old sessions, keeps busy/waiting/pinned/recent ones, sweeps old unreferenced attachments, vacuums', async () => {
    const t = setup()
    const old = NOW - 40 * DAY
    // Old and idle: removed.
    t.store.append(created('old', old) as never)
    // Old but pinned: kept.
    t.store.append(created('pinned', old) as never)
    t.store.append({ type: 'session.pinned', sessionId: 'pinned', at: old, pinned: true } as never)
    // Old but a turn is running: kept.
    t.store.append(created('busy', old) as never)
    t.store.append({ type: 'turn.started', sessionId: 'busy', at: old } as never)
    // Old but waiting on the user: kept.
    t.store.append(created('waiting', old) as never)
    t.store.append({
      type: 'approval.requested',
      sessionId: 'waiting',
      at: old,
      requestId: 'r1',
      title: 'ok?',
      options: [{ id: 'a', label: 'Allow', kind: 'allow' }],
    } as never)
    // Recent: kept.
    t.store.append(created('fresh', NOW - DAY) as never)
    // Old session whose attachment is still referenced by its own (deleted) log? No: reference
    // from a kept session's queued prompt keeps the attachment.
    const attRoot = t.attachments.root
    const keptAtt = path.join(attRoot, 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa')
    mkdirSync(keptAtt, { recursive: true })
    writeFileSync(path.join(keptAtt, 'f.txt'), 'x'.repeat(100))
    const oldAtt = path.join(attRoot, 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb')
    mkdirSync(oldAtt, { recursive: true })
    writeFileSync(path.join(oldAtt, 'old.txt'), 'x'.repeat(50))
    const recentAtt = path.join(attRoot, 'cccccccc-3333-4333-8333-cccccccccccc')
    mkdirSync(recentAtt, { recursive: true })
    writeFileSync(path.join(recentAtt, 'new.txt'), 'x'.repeat(10))
    // Age the folders: old ones 40 days, recent one 1 day.
    const oldTime = new Date(NOW - 40 * DAY)
    utimesSync(keptAtt, oldTime, oldTime)
    utimesSync(oldAtt, oldTime, oldTime)
    t.store.append({
      type: 'prompt.queued',
      sessionId: 'fresh',
      at: NOW - DAY,
      queueId: 'q1',
      text: 'with file',
      attachments: [{ name: 'f.txt', path: path.join(keptAtt, 'f.txt') }],
    } as never)

    const report = await garbageCollect(t.deps, { days: 30 })
    expect(t.deleted).toEqual(['old'])
    expect(report.sessionsRemoved).toBe(1)
    const kept = report.sessions.filter((s) => !s.removed).map((s) => s.id)
    expect(kept.sort()).toEqual(['busy', 'fresh', 'pinned', 'waiting'])
    // Attachments: old unreferenced gone, old referenced kept, recent kept.
    expect(report.attachmentsRemoved).toBe(1)
    expect(report.attachmentBytesFreed).toBe(50)
    expect(t.gitRemoved).toEqual([]) // stale worktrees only with worktrees: true
    expect(report.vacuumed).toBe(true)
    expect(report.dbBytesAfter).toBeLessThanOrEqual(report.dbBytesBefore)
  })

  it('dry run changes nothing but reports what would go', async () => {
    const t = setup()
    const old = NOW - 40 * DAY
    t.store.append(created('old', old) as never)
    const report = await garbageCollect(t.deps, { days: 30, dryRun: true })
    expect(report.dryRun).toBe(true)
    expect(report.sessionsRemoved).toBe(1)
    expect(report.sessions[0]!.removed).toBe(true)
    expect(t.deleted).toEqual([])
    expect(report.vacuumed).toBe(false)
  })

  it('removes worktrees of removed sessions and stale worktree folders when asked', async () => {
    const t = setup()
    const old = NOW - 40 * DAY
    const proj = path.join(t.dir, 'proj')
    const wt = path.join(proj, '.wt', 's-old')
    t.store.append(created('old', old, { cwd: wt, worktree: { baseBranch: 'main' } }) as never)
    mkdirSync(wt, { recursive: true })
    mkdirSync(path.join(proj, '.wt', 'stale'), { recursive: true })

    const report = await garbageCollect(t.deps, { days: 30, worktrees: true })
    expect(t.worktreesRemoved).toEqual(['old'])
    expect(t.gitRemoved).toEqual([path.resolve(path.join(proj, '.wt', 'stale'))])
    expect(report.worktreesRemoved).toBe(2)
  })

  it('keeps everything when nothing is old enough', async () => {
    const t = setup()
    t.store.append(created('fresh', NOW - 2 * DAY) as never)
    const report = await garbageCollect(t.deps, { days: 30 })
    expect(report.sessionsRemoved).toBe(0)
    expect(t.deleted).toEqual([])
  })
})
