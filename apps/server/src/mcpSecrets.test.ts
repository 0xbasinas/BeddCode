import { mkdtemp, readFile, stat, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ProviderAdapter } from '@beddcode/provider-core'
import { protectMcpSecrets } from './mcpSecrets.ts'

it('stores secrets privately, passes references and redacts listings and errors', async () => {
  const home = await mkdtemp(join(tmpdir(), 'mcp-secrets-'))
  try {
    const add = vi.fn().mockResolvedValue(undefined)
    const adapter = {
      kind: 'claude',
      mcp: {
        add,
        list: async () => [
          {
            name: 'r',
            transport: 'http',
            target: 'Authorization: secret',
            status: 'failed',
            error: 'secret',
          },
        ],
        remove: vi.fn(),
      },
    } as unknown as ProviderAdapter
    const env: Record<string, string> = {}
    await protectMcpSecrets(home, env, [adapter])
    await adapter.mcp!.add('id', {
      name: 'r',
      transport: 'http',
      url: 'https://x',
      headers: { Authorization: 'secret' },
    })
    const passed = add.mock.calls[0]![1]
    expect(passed.headers.Authorization).toMatch(/^\$\{BEDDCODE_MCP_/)
    expect(JSON.stringify(passed)).not.toContain('secret')
    expect(Object.values(env)).toContain('secret')
    expect((await stat(join(home, 'mcp-secrets.json'))).mode & 0o777).toBe(0o600)
    expect(await readFile(join(home, 'mcp-secrets.json'), 'utf8')).toContain('secret')
    expect(await adapter.mcp!.list('id')).toMatchObject([
      { target: 'Authorization: ••••', error: '••••' },
    ])
    add.mockRejectedValueOnce(new Error('secret'))
    await expect(
      adapter.mcp!.add('id', {
        name: 'r',
        transport: 'http',
        url: 'https://x',
        bearerToken: 'secret',
      }),
    ).rejects.not.toThrow('secret')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
