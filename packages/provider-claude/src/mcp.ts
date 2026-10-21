import type { McpServer, McpServerInput } from '@beddcode/contracts'
import type { ProviderMcp } from '@beddcode/provider-core'
import { runCommand, type RunResult } from '@beddcode/shared'

type Run = (file: string, args: string[], cwd?: string) => Promise<RunResult>

/**
 * `claude mcp list` prints `name: target - ✔ Connected` per line. The name may contain spaces
 * (hosted connectors do), so the target is whatever lies between the first ": " and the last " - ".
 */
export function parseMcpList(output: string): McpServer[] {
  const servers: McpServer[] = []
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trim()
    const dash = line.lastIndexOf(' - ')
    const colon = line.indexOf(': ')
    if (dash < 0 || colon < 0 || colon > dash) continue

    const name = line.slice(0, colon)
    const target = line.slice(colon + 2, dash)
    const state = line.slice(dash + 3)
    const sse = /\(SSE\)$/i.test(target)
    const cleanTarget = target.replace(/\s*\((SSE|HTTP)\)$/i, '')

    let status: McpServer['status'] = 'unknown'
    if (/connected/i.test(state) && !/fail/i.test(state)) status = 'connected'
    else if (/authenticat/i.test(state)) status = 'needs-auth'
    else if (/fail|error/i.test(state)) status = 'failed'
    else if (/disabled/i.test(state)) status = 'disabled'
    else if (/pending|connecting/i.test(state)) status = 'pending'

    servers.push({
      name,
      transport: /^https?:\/\//i.test(cleanTarget) ? (sse ? 'sse' : 'http') : 'stdio',
      target: cleanTarget,
      status,
      error: status === 'failed' ? state.replace(/^[✗x]\s*/i, '') : undefined,
    })
  }
  return servers
}

/** The arguments of `claude mcp add` for a server definition. */
export function addArgs(server: McpServerInput): string[] {
  const args = ['mcp', 'add', '--scope', server.scope ?? 'user']
  if (server.transport !== 'stdio') args.push('--transport', server.transport)
  for (const [key, value] of Object.entries(server.env ?? {})) args.push('-e', `${key}=${value}`)
  args.push(server.name)
  if (server.transport === 'stdio') {
    if (!server.command) throw new Error('A command is needed for a local MCP server')
    args.push('--', server.command, ...(server.args ?? []))
  } else {
    if (!server.url) throw new Error('A URL is needed for a remote MCP server')
    args.push(server.url)
  }
  return args
}

/** MCP servers managed through Claude Code's own CLI, so its config files stay the one source. */
export function createClaudeMcp(
  executable: () => string | null,
  env: Record<string, string | undefined> | undefined,
  run: Run = (file, args, cwd) =>
    runCommand(file, args, { cwd, env: { ...process.env, ...env }, timeoutMs: 60_000 }),
): ProviderMcp {
  const exe = () => {
    const found = executable()
    if (!found) throw new Error('Claude Code is not installed on this host')
    return found
  }
  const must = async (args: string[], cwd?: string) => {
    const res = await run(exe(), args, cwd)
    if (res.code !== 0) throw new Error((res.stderr || res.stdout).trim() || 'claude mcp failed')
    return res
  }

  return {
    async list(_instanceId, cwd) {
      // The listing connects to every server to report its health, so it can take a few seconds.
      return parseMcpList((await must(['mcp', 'list'], cwd)).stdout)
    },
    async add(_instanceId, server, cwd) {
      await must(addArgs(server), cwd)
    },
    async remove(_instanceId, name, scope, cwd) {
      await must(['mcp', 'remove', ...(scope ? ['--scope', scope] : []), name], cwd)
    },
  }
}
