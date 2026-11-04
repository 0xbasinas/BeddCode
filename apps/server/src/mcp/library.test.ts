import { describe, expect, it, vi } from 'vitest'
import type { ProviderMcp } from '@beddcode/provider-core'
import { copyMcpServer, mcpOverview } from './library.ts'

const item = (target: string) => ({
  name: 'example',
  transport: 'stdio' as const,
  target,
  status: 'unknown' as const,
})
const agent = (instanceId: string, mcp: Partial<ProviderMcp>) => ({
  instanceId,
  label: instanceId,
  mcp: { list: vi.fn().mockResolvedValue([]), add: vi.fn(), remove: vi.fn(), ...mcp },
})

describe('MCP library', () => {
  it('merges servers, flags mismatches and reports failed agents', async () => {
    const result = await mcpOverview([
      agent('one', { list: vi.fn().mockResolvedValue([item('one')]) }),
      agent('two', { list: vi.fn().mockResolvedValue([item('two')]) }),
      agent('three', { list: vi.fn().mockRejectedValue(new Error('secret')) }),
    ])
    expect(result.servers[0]).toMatchObject({
      name: 'example',
      mismatch: true,
      agents: [{ instanceId: 'one' }, { instanceId: 'two' }],
    })
    expect(JSON.stringify(result)).not.toContain('secret')
    expect(result.errors).toHaveLength(1)
  })
  it('copies full configuration, skips existing names, and hides errors', async () => {
    const definition = {
      name: 'example',
      transport: 'stdio' as const,
      command: 'node',
      args: ['a b'],
      env: {},
    }
    const source = agent('one', { get: vi.fn().mockResolvedValue(definition) })
    const target = agent('two', {})
    const existing = agent('three', { list: vi.fn().mockResolvedValue([item('other')]) })
    const failed = agent('four', { add: vi.fn().mockRejectedValue(new Error('secret')) })
    const result = await copyMcpServer([source, target, existing, failed], 'one', 'example')
    expect(target.mcp.add).toHaveBeenCalledWith('two', definition, undefined)
    expect(existing.mcp.add).not.toHaveBeenCalled()
    expect(result.map((r) => r.status)).toEqual(['copied', 'skipped', 'failed'])
    expect(JSON.stringify(result)).not.toContain('secret')
  })
  it('does not persist environment values in agent configuration', async () => {
    const source = agent('one', {
      get: vi.fn().mockResolvedValue({
        name: 'example',
        transport: 'stdio',
        command: 'node',
        env: { TOKEN: 'secret' },
      }),
    })
    const target = agent('two', {})
    await expect(copyMcpServer([source, target], 'one', 'example')).rejects.toThrow(
      'environment values',
    )
    expect(target.mcp.add).not.toHaveBeenCalled()
  })
})
