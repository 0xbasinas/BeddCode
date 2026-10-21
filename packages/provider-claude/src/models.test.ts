import { describe, expect, it, vi } from 'vitest'
import type { ModelInfo, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { discoverClaudeModels } from './models.ts'
import type { QueryFn } from './session.ts'

function catalog(read: () => Promise<ModelInfo[]>) {
  let options: Options | undefined
  let prompt: AsyncIterable<SDKUserMessage> | undefined
  const close = vi.fn()
  const queryFn: QueryFn = (params) => {
    options = params.options
    prompt = params.prompt
    return { supportedModels: read, close } as unknown as Query
  }
  return { queryFn, close, options: () => options!, prompt: () => prompt! }
}

describe('Claude model discovery', () => {
  it('uses CLI versioned names, aliases, custom IDs, and per-model effort choices', async () => {
    const fake = catalog(async () => [
      {
        value: 'sonnet',
        displayName: 'Sonnet',
        description: 'Sonnet 5.5 · Efficient for routine tasks',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'max'],
      },
      {
        value: 'hosted-model[1m]',
        displayName: 'Company model',
        description: 'Our hosted endpoint',
        supportsEffort: false,
        supportedEffortLevels: ['high'],
      },
      { value: 'older', displayName: 'Older CLI model', description: 'No effort metadata' },
    ])
    const models = await discoverClaudeModels(fake.queryFn, '/bin/claude', {
      CLAUDE_CONFIG_DIR: '/account',
    })
    expect(models).toEqual([
      {
        id: 'sonnet',
        label: 'Sonnet 5.5',
        description: 'Sonnet 5.5 · Efficient for routine tasks',
        efforts: ['low', 'medium', 'high', 'max'],
      },
      {
        id: 'hosted-model[1m]',
        label: 'Company model',
        description: 'Our hosted endpoint',
        efforts: [],
      },
      { id: 'older', label: 'Older CLI model', description: 'No effort metadata', efforts: [] },
    ])
    expect(fake.options()).toMatchObject({
      pathToClaudeCodeExecutable: '/bin/claude',
      env: { CLAUDE_CONFIG_DIR: '/account' },
      persistSession: false,
      extraArgs: { bare: null },
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settings: { disableAllHooks: true },
      settingSources: ['user', 'project', 'local'],
    })
    expect(fake.options().abortController?.signal.aborted).toBe(true)
    expect(fake.close).toHaveBeenCalledOnce()
    // No prompt was ever queued; iteration ends only after the metadata process closes.
    expect(await fake.prompt()[Symbol.asyncIterator]().next()).toMatchObject({ done: true })
  })

  it('keeps complete display names and does not turn descriptive prose into model names', async () => {
    const fake = catalog(async () => [
      { value: 'a', displayName: 'Opus 5.5', description: 'Best for complex tasks' },
      { value: 'b', displayName: 'Sonnet', description: 'Sonnet is fast and capable' },
      { value: 'c', displayName: 'Fable', description: 'Fable 5.1 · Most capable' },
    ])
    const models = await discoverClaudeModels(fake.queryFn, '/bin/claude')
    expect(models.map((model) => model.label)).toEqual(['Opus 5.5', 'Sonnet', 'Fable 5.1'])
  })

  it('closes a stalled metadata process within the deadline', async () => {
    const fake = catalog(() => new Promise(() => {}))
    await expect(discoverClaudeModels(fake.queryFn, '/bin/claude', undefined, 10)).rejects.toThrow(
      'timed out',
    )
    expect(fake.close).toHaveBeenCalledOnce()
    expect(fake.options().abortController?.signal.aborted).toBe(true)
  })

  it('closes a failed metadata process', async () => {
    const fake = catalog(async () => {
      throw new Error('CLI incompatible')
    })
    await expect(discoverClaudeModels(fake.queryFn, '/bin/claude')).rejects.toThrow(
      'CLI incompatible',
    )
    expect(fake.close).toHaveBeenCalledOnce()
  })

  it('rejects an empty catalog so the adapter can retain its unversioned aliases', async () => {
    const fake = catalog(async () => [])
    await expect(discoverClaudeModels(fake.queryFn, '/bin/claude')).rejects.toThrow(
      'empty model catalog',
    )
    expect(fake.close).toHaveBeenCalledOnce()
  })
})
