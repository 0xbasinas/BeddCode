import { describe, expect, it } from 'vitest'
import type { ProviderInstance, ProviderKind } from '@beddcode/contracts'
import { chooseHandoffAgent, detectHandoffTrigger, type HandoffPolicy } from './autoHandoff.ts'

const provider = (id: string, status: ProviderInstance['status'] = 'ready') =>
  ({ id, status }) as ProviderInstance
const policy: HandoffPolicy = {
  mode: 'auto',
  fallback: ['a', 'b', 'c'],
  maxHops: 2,
  cooldownMs: 1000,
}

describe('automatic handoff triggers', () => {
  it.each<[ProviderKind, string]>([
    ['codex', 'usage limit reached'],
    ['claude', 'prompt is too long'],
    ['grok', 'credits exhausted'],
    ['acp', 'not authenticated'],
    ['pi', 'no api key'],
    ['opencode', 'quota exceeded'],
    ['fake', 'rate limit'],
  ])('maps %s errors', (kind, message) => expect(detectHandoffTrigger(kind, message)).toBe(message))
  it('requires repeated generic failures and ignores normal errors', () => {
    expect(detectHandoffTrigger('codex', 'request failed', 2)).toBeUndefined()
    expect(detectHandoffTrigger('codex', 'request failed', 3)).toBe('request failed')
    expect(detectHandoffTrigger('codex', 'file not found', 4)).toBeUndefined()
  })
})
describe('handoff policy', () => {
  it('honors order, readiness, cooldown, mode and hop limit', () => {
    const agents = [provider('a', 'needs-sign-in'), provider('b'), provider('c')]
    expect(chooseHandoffAgent(policy, agents, { b: 9500 }, 0, 10000)?.id).toBe('c')
    expect(chooseHandoffAgent(policy, agents, { b: 9000 }, 0, 10000)?.id).toBe('b')
    expect(chooseHandoffAgent(policy, agents, {}, 2, 10000)).toBeUndefined()
    expect(chooseHandoffAgent({ ...policy, mode: 'off' }, agents, {}, 0)).toBeUndefined()
  })
})
