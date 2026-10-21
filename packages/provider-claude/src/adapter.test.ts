import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { createLogger, resolveExecutable, runCommand } from '@beddcode/shared'
import { claudeCapabilities, createClaudeAdapter } from './adapter.ts'
import type { QueryFn } from './session.ts'

vi.mock('@beddcode/shared', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@beddcode/shared')>()),
  resolveExecutable: vi.fn(),
  runCommand: vi.fn(),
}))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(resolveExecutable).mockReturnValue('/bin/claude')
  vi.mocked(runCommand).mockResolvedValue({ code: 0, stdout: '{"loggedIn":true}', stderr: '' })
})
const log = createLogger('claude-test', 'error')

describe('Claude adapter model capabilities', () => {
  it('publishes the discovered catalog to detection and session capabilities', async () => {
    const close = vi.fn()
    const queryFn: QueryFn = () =>
      ({
        supportedModels: async () => [
          {
            value: 'opus',
            displayName: 'Opus',
            description: 'Opus 5.5 · Best for complex tasks',
            supportedEffortLevels: ['high', 'max'],
          },
        ],
        close,
      }) as unknown as Query
    const adapter = createClaudeAdapter({ queryFn, log })
    const [instance] = await adapter.detect()
    expect(instance?.status).toBe('ready')
    expect(instance?.capabilities.models).toEqual([
      {
        id: 'opus',
        label: 'Opus 5.5',
        description: 'Opus 5.5 · Best for complex tasks',
        efforts: ['high', 'max'],
      },
    ])
    expect(adapter.capabilities('claude')).toEqual(instance?.capabilities)
    expect(close).toHaveBeenCalledOnce()

    vi.mocked(resolveExecutable).mockReturnValue(null)
    expect((await adapter.detect())[0]?.status).toBe('not-installed')
    expect(adapter.capabilities('claude')).toEqual(claudeCapabilities)
  })

  it('keeps usable aliases without inventing version numbers when discovery fails', async () => {
    const queryFn = vi.fn(() => {
      throw new Error('Older CLI does not support discovery')
    })
    const adapter = createClaudeAdapter({ queryFn, log })
    const [instance] = await adapter.detect()
    expect(instance?.status).toBe('ready')
    expect(instance?.capabilities).toEqual(claudeCapabilities)
    expect(instance?.capabilities.models?.map((model) => model.id)).toEqual([
      'sonnet',
      'opus',
      'haiku',
    ])
    expect(instance?.capabilities.efforts).toEqual([])
  })

  it.each([
    { code: 1, stdout: '', stderr: 'Not signed in' },
    { code: 0, stdout: '{"loggedIn":false}', stderr: '' },
  ])('does not discover models when authentication is unavailable: %j', async (auth) => {
    vi.mocked(runCommand).mockResolvedValueOnce({ code: 0, stdout: '2.1.306', stderr: '' })
    vi.mocked(runCommand).mockResolvedValueOnce(auth)
    const queryFn = vi.fn()
    const adapter = createClaudeAdapter({ queryFn, log })
    expect((await adapter.detect())[0]?.status).toBe('needs-sign-in')
    expect(queryFn).not.toHaveBeenCalled()
  })
})
