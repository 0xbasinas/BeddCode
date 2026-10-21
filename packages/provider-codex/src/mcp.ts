import type { McpServer, McpServerInput } from '@beddcode/contracts'
import type { ProviderMcp } from '@beddcode/provider-core'
import { runCommand, type RunResult } from '@beddcode/shared'

type Run = (file: string, args: string[], cwd?: string) => Promise<RunResult>
type Obj = Record<string, unknown>

/** `codex mcp list --json`: servers from the user's own config.toml. */
export function parseMcpJson(output: string): McpServer[] {
  let list: unknown
  try {
    list = JSON.parse(output)
  } catch {
    throw new Error('Codex did not return its MCP servers')
  }
  if (!Array.isArray(list)) return []

  return (list as Obj[]).map((entry): McpServer => {
    const transport = (entry.transport ?? {}) as Obj
    const stdio = transport.type === 'stdio'
    const target = stdio
      ? [transport.command, ...(Array.isArray(transport.args) ? transport.args : [])]
          .filter((part) => typeof part === 'string')
          .join(' ')
      : String(transport.url ?? '')
    const auth = String(entry.auth_status ?? '')
    return {
      name: String(entry.name),
      transport: stdio ? 'stdio' : transport.type === 'streamable_http' ? 'http' : 'unknown',
      target,
      // The CLI does not connect, so a server that is on and signed in is "configured", not known-good.
      status:
        entry.enabled === false
          ? 'disabled'
          : /not_logged_in/i.test(auth)
            ? 'needs-auth'
            : 'unknown',
      error: typeof entry.disabled_reason === 'string' ? entry.disabled_reason : undefined,
    }
  })
}

export function addArgs(server: McpServerInput): string[] {
  const args = ['mcp', 'add', server.name]
  for (const [key, value] of Object.entries(server.env ?? {})) args.push('--env', `${key}=${value}`)
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error('A command is needed for a local MCP server')
    args.push('--', server.command, ...(server.args ?? []))
  } else {
    if (!server.url) throw new Error('A URL is needed for a remote MCP server')
    if (Object.keys(server.env ?? {}).length > 0) {
      throw new Error('Environment variables only apply to local MCP servers')
    }
    args.push('--url', server.url)
  }
  return args
}

/** Codex keeps MCP servers in ~/.codex/config.toml; its own CLI edits that file. */
export function createCodexMcp(
  executable: () => string | null,
  env: Record<string, string | undefined>,
  run: Run = (file, args, cwd) => runCommand(file, args, { cwd, env, timeoutMs: 30_000 }),
): ProviderMcp {
  const must = async (args: string[], cwd?: string) => {
    const exe = executable()
    if (!exe) throw new Error('Codex is not installed on this host')
    const res = await run(exe, args, cwd)
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || 'codex mcp failed')
    return res
  }
  return {
    async list(_instanceId, cwd) {
      return parseMcpJson((await must(['mcp', 'list', '--json'], cwd)).stdout)
    },
    async add(_instanceId, server, cwd) {
      await must(addArgs(server), cwd)
    },
    async remove(_instanceId, name, _scope, cwd) {
      await must(['mcp', 'remove', name], cwd)
    },
  }
}
