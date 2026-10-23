import { describe, expect, it } from 'vitest'
import {
  DEFAULT_IDLE_MS,
  evaluateIdleTick,
  idleTimeoutMs,
  isProgress,
  replaySettled,
} from './idle.ts'

describe('evaluateIdleTick', () => {
  const base = { turnActive: true, awaitingUser: false, idleMs: 0, timeoutMs: 1000 }
  it('stops when the turn is over, whatever else is true', () => {
    expect(evaluateIdleTick({ ...base, turnActive: false, idleMs: 9999 })).toBe('stop')
  })
  it('does not count the time spent waiting for the user', () => {
    expect(evaluateIdleTick({ ...base, awaitingUser: true, idleMs: 9999 })).toBe('touch')
  })
  it('gives up only once the silence reaches the limit', () => {
    expect(evaluateIdleTick({ ...base, idleMs: 999 })).toBe('continue')
    expect(evaluateIdleTick({ ...base, idleMs: 1000 })).toBe('timeout')
  })
})

describe('idleTimeoutMs', () => {
  it('takes the override, and ignores anything unusable', () => {
    expect(idleTimeoutMs({ BEDDCODE_ACP_IDLE_MS: '60000' })).toBe(60000)
    for (const bad of ['', ' ', 'soon', '0', '-5', undefined]) {
      expect(idleTimeoutMs({ BEDDCODE_ACP_IDLE_MS: bad })).toBe(DEFAULT_IDLE_MS)
    }
  })
})

describe('isProgress', () => {
  it('counts words, thoughts, tools and plans, not settings or usage', () => {
    for (const yes of [
      'agent_message_chunk',
      'agent_thought_chunk',
      'tool_call',
      'tool_call_update',
      'plan',
    ]) {
      expect(isProgress(yes)).toBe(true)
    }
    for (const no of [
      'usage_update',
      'config_option_update',
      'current_mode_update',
      'available_commands_update',
      'session_info_update',
    ]) {
      expect(isProgress(no)).toBe(false)
    }
  })
})

describe('replaySettled', () => {
  const t = { startedAt: 1000, quietMs: 150, hardMs: 2000 }
  it('waits while updates are still arriving', () => {
    expect(replaySettled({ ...t, now: 1100, lastActivityAt: 1090 })).toBe(false)
  })
  it('is over after a quiet moment', () => {
    expect(replaySettled({ ...t, now: 1300, lastActivityAt: 1100 })).toBe(true)
  })
  it('is over when it has gone on too long, however busy', () => {
    expect(replaySettled({ ...t, now: 3000, lastActivityAt: 2990 })).toBe(true)
  })
})
