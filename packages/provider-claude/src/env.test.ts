import { describe, expect, it } from 'vitest'
import { claudeProcessEnv, DEFAULT_API_TIMEOUT_MS } from './env.ts'

describe('claudeProcessEnv', () => {
  it('adds a shorter API timeout and keeps the rest of the environment', () => {
    const env = claudeProcessEnv({ PATH: '/bin', HOME: '/h' }, { FOO: 'bar' })
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/h', FOO: 'bar' })
    expect(env.API_TIMEOUT_MS).toBe(DEFAULT_API_TIMEOUT_MS)
  })

  it("respects the user's own timeout, from the host or the deps", () => {
    expect(claudeProcessEnv({ API_TIMEOUT_MS: '600000' }).API_TIMEOUT_MS).toBe('600000')
    expect(claudeProcessEnv({}, { API_TIMEOUT_MS: '5000' }).API_TIMEOUT_MS).toBe('5000')
  })

  it('ignores an empty or undefined timeout', () => {
    expect(claudeProcessEnv({ API_TIMEOUT_MS: '' }).API_TIMEOUT_MS).toBe(DEFAULT_API_TIMEOUT_MS)
    expect(claudeProcessEnv({}, { API_TIMEOUT_MS: undefined }).API_TIMEOUT_MS).toBe(
      DEFAULT_API_TIMEOUT_MS,
    )
  })
})
