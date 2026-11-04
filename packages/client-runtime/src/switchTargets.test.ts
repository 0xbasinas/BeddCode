import { describe, expect, it } from 'vitest'
import type { ProviderInstance } from '@beddcode/contracts'
import { defaultSwitchTarget, findSwitchTarget, switchTargets } from './switchTargets.ts'

const provider = (id: string, status: ProviderInstance['status'] = 'ready') =>
  ({ id, label: id.toUpperCase(), status }) as ProviderInstance

describe('switch targets', () => {
  it('skips an unready first agent', () => {
    const list = [provider('claude'), provider('grok', 'needs-sign-in'), provider('codex')]
    expect(defaultSwitchTarget(list, 'claude')?.id).toBe('codex')
  })
  it('has no default when no other agent is ready', () => {
    const list = [
      provider('claude'),
      provider('grok', 'needs-sign-in'),
      provider('pi', 'not-installed'),
    ]
    expect(defaultSwitchTarget(list, 'claude')).toBeUndefined()
  })
  it('excludes the current agent', () => {
    const list = [provider('claude'), provider('codex')]
    expect(defaultSwitchTarget(list, 'claude')?.id).toBe('codex')
    expect(defaultSwitchTarget([provider('claude')], 'claude')).toBeUndefined()
    expect(switchTargets(list, 'claude').map((t) => t.provider.id)).toEqual(['codex'])
  })
  it('lists unready agents with a reason', () => {
    const list = [provider('grok', 'needs-sign-in'), provider('pi', 'not-installed')]
    expect(switchTargets(list, 'x').map((t) => [t.ready, t.reason])).toEqual([
      [false, 'Not signed in'],
      [false, 'Not installed'],
    ])
  })
  it('explains an unready agent named in /switch', () => {
    const list = [provider('grok', 'needs-sign-in'), provider('codex')]
    expect(findSwitchTarget(list, 'claude', 'Grok')).toEqual({
      error: 'GROK is not ready: Not signed in',
    })
    expect(findSwitchTarget(list, 'claude', 'codex')).toEqual({ provider: list[1] })
    expect(findSwitchTarget(list, 'codex', 'codex')).toEqual({
      error: 'No agent matches that name',
    })
  })
})
