import { describe, expect, it } from 'vitest'
import { createGrokAdapter, listGrokCommands, parseModels, signedIn } from './adapter.ts'

describe('parseModels', () => {
  it('reads the model list from `grok models`', () => {
    const out = [
      'You are logged in with grok.com.',
      '',
      'Default model: grok-4.7-build-fast',
      '',
      'Available models:',
      '  - grok-4.7',
      '  * grok-4.7-build-fast (default)',
      '  - grok-4.6',
    ].join('\n')
    expect(parseModels(out).map((m) => m.id)).toEqual([
      'grok-4.7',
      'grok-4.7-build-fast',
      'grok-4.6',
    ])
  })
})

describe('signedIn', () => {
  it('tells signed in from signed out, and stays quiet when unsure', () => {
    expect(signedIn('You are logged in with grok.com.', '')).toBe(true)
    expect(signedIn('', 'You are not logged in. Run grok login')).toBe(false)
    expect(signedIn('', '')).toBeUndefined()
  })
})

describe('createGrokAdapter', () => {
  it('reports not-installed when there is no binary', async () => {
    const adapter = createGrokAdapter({ executablePath: '/nope/grok' })
    expect((await adapter.detect())[0]).toMatchObject({ kind: 'grok', status: 'not-installed' })
  })

  it('is ready with models when the binary answers', async () => {
    const adapter = createGrokAdapter({
      executablePath: process.execPath,
      run: (async (_f: string, args: string[]) => ({
        code: 0,
        stdout:
          args[0] === '--version'
            ? 'grok 1.0.70'
            : 'You are logged in with grok.com.\n  - grok-4.7\n',
        stderr: '',
      })) as never,
    })
    const [instance] = await adapter.detect()
    expect(instance).toMatchObject({ status: 'ready', version: '1.0.70' })
    expect(instance!.capabilities.models?.map((m) => m.id)).toEqual(['grok-4.7'])
    expect(instance!.capabilities.permissionModes.map((m) => m.id)).toEqual(['ask', 'approve-all'])
  })

  it('needs sign-in when Grok says it is signed out', async () => {
    const saved = process.env.XAI_API_KEY
    delete process.env.XAI_API_KEY
    try {
      const adapter = createGrokAdapter({
        executablePath: process.execPath,
        run: (async (_f: string, args: string[]) => ({
          code: 0,
          stdout: args[0] === '--version' ? '1.0.70' : 'You are not logged in',
          stderr: '',
        })) as never,
      })
      expect((await adapter.detect())[0]).toMatchObject({ status: 'needs-sign-in' })
    } finally {
      if (saved !== undefined) process.env.XAI_API_KEY = saved
    }
  })
})

describe('listGrokCommands', () => {
  const inspect = JSON.stringify({
    skills: [
      { name: 'review', description: 'Review a change', source: 'bundled', userInvocable: true },
      { name: 'internal', description: 'Hidden', source: 'bundled', userInvocable: false },
      { name: 'plain', source: 'user' },
    ],
    mcpServers: [{ name: 'secret', url: 'https://example.com/?token=abc' }],
  })
  const run = (stdout: string, code = 0) => (async () => ({ code, stdout, stderr: '' })) as never

  it('lists the invocable skills and nothing else from the configuration', async () => {
    const commands = await listGrokCommands(() => 'grok', run(inspect), {})
    expect(commands).toEqual([
      { name: 'review', kind: 'skill', description: 'Review a change' },
      { name: 'plain', kind: 'skill' },
    ])
    expect(JSON.stringify(commands)).not.toContain('token')
  })

  it('returns nothing when Grok fails or says something else', async () => {
    expect(await listGrokCommands(() => 'grok', run('', 1), {})).toEqual([])
    expect(await listGrokCommands(() => 'grok', run('not json'), {})).toEqual([])
    expect(await listGrokCommands(() => null, run(inspect), {})).toEqual([])
  })
})
