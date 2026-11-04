import { describe, expect, it, vi } from 'vitest'
import { createLogger } from '@beddcode/shared'
import { createClaudeAdapter, isClaudeSignedIn } from './adapter.ts'
import { ClaudeCliSession } from './cli/session.ts'
import { ClaudeSession } from './session.ts'

vi.mock('@beddcode/shared', async (original) => ({
  ...(await original<typeof import('@beddcode/shared')>()),
  resolveExecutable: () => '/bin/claude',
}))
vi.mock('./cli/session.ts', () => ({ ClaudeCliSession: class {} }))
vi.mock('./session.ts', () => ({ ClaudeSession: class {} }))

describe('Claude backend', () => {
  it.each([
    [undefined, undefined, ClaudeSession],
    ['cli', undefined, ClaudeCliSession],
    ['cli', 'sdk', ClaudeSession],
    ['sdk', 'cli', ClaudeCliSession],
  ] as const)('selects host %s and project %s', async (backend, override, expected) => {
    const adapter = createClaudeAdapter({ backend, log: createLogger('test') })
    const session = await adapter.startSession('claude', {
      sessionId: 's',
      cwd: '/tmp',
      claudeBackend: override,
    })
    expect(session).toBeInstanceOf(expected)
  })
  it.each([
    ['{"loggedIn":true}', 0, true],
    ['{"loggedIn":false}', 0, false],
    ['Not signed in', 0, false],
    ['Logged in as user', 0, true],
    ['', 1, false],
  ] as const)('parses authentication %s', (text, code, expected) => {
    expect(isClaudeSignedIn(text, code)).toBe(expected)
  })
})
