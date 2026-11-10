import { describe, expect, it } from 'vitest'
import { defaultHandoffPolicy, policyFor } from './autoHandoffPolicy'

describe('handoff policy lookup', () => {
  it('falls back from a folder, to the host, to the default', () => {
    expect(policyFor({}, 'h', '/repo')).toEqual(defaultHandoffPolicy)
    const hosts = {
      h: {
        global: { ...defaultHandoffPolicy, mode: 'ask' as const, fallback: ['claude'] },
        projects: {
          '/repo': { ...defaultHandoffPolicy, mode: 'auto' as const, fallback: ['codex'] },
        },
      },
    }
    expect(policyFor(hosts, 'h', '/repo').mode).toBe('auto')
    expect(policyFor(hosts, 'h', '/other').mode).toBe('ask')
    expect(policyFor(hosts, 'h').fallback).toEqual(['claude'])
  })
})
