import { describe, expect, it } from 'vitest'
import type { GcReport, HostStats, Schedule } from '@beddcode/contracts'
import { sanitizeConfig } from '../config.ts'
import { parseValue, settingKey } from './configCmd.ts'
import { formatGcReport } from './gc.ts'
import { formatSchedules } from './manageCmds.ts'
import { formatStats } from './stats.ts'

const NOW = new Date('2026-11-09T12:00:00Z').getTime()

const stats = (over: Partial<HostStats> = {}): HostStats => ({
  host: { hostId: 'host-1234-abcd', name: 'devbox', platform: 'linux', version: '1.2.3' },
  uptimeSeconds: 3723,
  seq: 481,
  counters: { sessions_created: 5, turns_started: 7, 'turns_completed{reason="done"}': 6 },
  sessions: {
    total: 4,
    byStatus: { starting: 0, running: 1, 'needs-you': 1, idle: 2, error: 0, cancelled: 0 },
    activeTurns: 1,
    activeTools: 2,
    openRequests: 1,
    queuedPrompts: 3,
    pinned: 1,
  },
  storage: {
    dbBytes: 12 * 1024 * 1024,
    attachmentsBytes: 3 * 1024 * 1024,
    staleWorktrees: ['/proj/.wt/gone'],
  },
  clients: { websockets: 2 },
  ...over,
})

describe('formatStats', () => {
  it('shows the host, its sessions, what is waiting and what the data weighs', () => {
    const text = formatStats(stats())
    expect(text).toContain('devbox')
    expect(text).toContain('up 1h 2m')
    expect(text).toContain('idle: 2')
    expect(text).toContain('waiting on you: 1')
    expect(text).toContain('queued: 3')
    expect(text).toContain('db 12.0 MiB')
    expect(text).toContain('stale worktrees: 1')
    expect(text).toContain('turns_completed{reason="done"}')
    expect(text).toContain('/proj/.wt/gone')
  })
})

describe('formatGcReport', () => {
  const report = (over: Partial<GcReport> = {}): GcReport => ({
    dryRun: false,
    cutoff: NOW - 30 * 86_400_000,
    sessions: [
      {
        id: 'aaaa1111-bbbb',
        title: 'Fix login',
        lastActiveAt: NOW - 40 * 86_400_000,
        status: 'idle',
        pinned: false,
        removed: true,
      },
      {
        id: 'cccc2222-dddd',
        title: 'Fresh',
        lastActiveAt: NOW - 86_400_000,
        status: 'idle',
        pinned: false,
        removed: false,
      },
    ],
    sessionsRemoved: 1,
    worktreesRemoved: 0,
    attachmentsRemoved: 2,
    attachmentBytesFreed: 2048,
    dbBytesBefore: 10_000_000,
    dbBytesAfter: 8_000_000,
    vacuumed: true,
    ...over,
  })

  it('says what went and what the log weighs now', () => {
    const text = formatGcReport(report(), NOW)
    expect(text).toContain('Removed sessions quiet for over 30d')
    expect(text).toContain('Fix login')
    expect(text).toContain('quiet 40d')
    expect(text).toContain('attachments 2 (2.0 KiB)')
    expect(text).toContain('log vacuumed: 9.5 MiB -> 7.6 MiB')
  })

  it('marks a dry run', () => {
    expect(formatGcReport(report({ dryRun: true, vacuumed: false }), NOW)).toContain(
      'Would remove sessions',
    )
  })
})

describe('watch schedules in the CLI', () => {
  it('shows a watch trigger as a glob, not a clock', () => {
    const s: Schedule = {
      id: 'aaaa1111',
      name: 'Tests on change',
      prompt: 'run the tests',
      trigger: { kind: 'watch', glob: 'src/**/*.ts', debounceMinutes: 10 },
      target: { kind: 'new', instanceId: 'codex', cwd: '/w' },
      paused: false,
      createdAt: 0,
    }
    const text = formatSchedules([s], NOW)
    expect(text).toContain('on src/**/*.ts changing')
  })
})

describe('retentionDays setting', () => {
  it('is a config setting with kebab-case name', () => {
    expect(settingKey('retention-days')).toBe('retentionDays')
    expect(parseValue('retentionDays', '14')).toBe(14)
    expect(parseValue('retentionDays', '0')).toBe(0)
    expect(() => parseValue('retentionDays', '3651')).toThrow('0 to 3650')
    expect(() => parseValue('retentionDays', 'x')).toThrow('whole number of days')
  })

  it('sanitizes the config file value', () => {
    expect(sanitizeConfig({ retentionDays: 14 }, () => {})).toEqual({ retentionDays: 14 })
    expect(sanitizeConfig({ retentionDays: '7' }, () => {})).toEqual({ retentionDays: 7 })
    const dropped = sanitizeConfig({ retentionDays: -1 }, () => {})
    expect(dropped.retentionDays).toBeUndefined()
    expect(sanitizeConfig({ retentionDays: 9999 }, () => {}).retentionDays).toBeUndefined()
  })
})
