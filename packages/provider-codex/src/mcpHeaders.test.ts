import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createCodexMcp } from './mcp.ts'

it('writes environment header references in Codex TOML', async () => {
  const home = await mkdtemp(join(tmpdir(), 'codex-mcp-'))
  try {
    const config = join(home, 'config.toml')
    await writeFile(config, '[mcp_servers.r]\nurl = "https://x"\n')
    const run = vi.fn().mockResolvedValue({ code: 0, stdout: '', stderr: '' })
    const mcp = createCodexMcp(() => 'codex', { CODEX_HOME: home }, run)
    await mcp.add('id', {
      name: 'r',
      transport: 'http',
      url: 'https://x',
      headers: { 'X-Key': 'BEDDCODE_MCP_KEY' },
      bearerToken: 'BEDDCODE_MCP_TOKEN',
    })
    expect(await readFile(config, 'utf8')).toContain(
      '[mcp_servers."r".env_http_headers]\n"X-Key" = "BEDDCODE_MCP_KEY"',
    )
    expect(run.mock.calls[0]![1]).toContain('BEDDCODE_MCP_TOKEN')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
