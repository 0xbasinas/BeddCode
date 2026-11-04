import type { McpServer } from '@beddcode/contracts'
import type { ProviderMcp } from '@beddcode/provider-core'

type Agent = { instanceId: string; label: string; mcp: ProviderMcp }

export async function mcpOverview(agents: Agent[], cwd?: string) {
  const servers = new Map<
    string,
    {
      name: string
      mismatch: boolean
      agents: { instanceId: string; label: string; server: McpServer }[]
    }
  >()
  const errors: { instanceId: string; label: string; error: string }[] = []
  await Promise.all(
    agents.map(async ({ instanceId, label, mcp }) => {
      try {
        for (const server of await mcp.list(instanceId, cwd)) {
          const row = servers.get(server.name) ?? { name: server.name, mismatch: false, agents: [] }
          row.agents.push({ instanceId, label, server })
          servers.set(server.name, row)
        }
      } catch {
        errors.push({ instanceId, label, error: 'Could not list MCP servers' })
      }
    }),
  )
  for (const row of servers.values())
    row.mismatch =
      new Set(row.agents.map(({ server }) => `${server.transport}\0${server.target}`)).size > 1
  return { servers: [...servers.values()].sort((a, b) => a.name.localeCompare(b.name)), errors }
}

export async function copyMcpServer(agents: Agent[], sourceId: string, name: string, cwd?: string) {
  const source = agents.find((agent) => agent.instanceId === sourceId)
  if (!source?.mcp.get)
    throw new Error('This agent cannot provide a server configuration for copying')
  let server
  try {
    server = await source.mcp.get(sourceId, name, cwd)
  } catch {
    throw new Error('Could not read the server configuration for copying')
  }
  if (Object.keys(server.env ?? {}).length > 0) {
    throw new Error(
      'Servers with environment values cannot be copied without storing them in agent configuration',
    )
  }
  return Promise.all(
    agents
      .filter((agent) => agent.instanceId !== sourceId)
      .map(async ({ instanceId, label, mcp }) => {
        try {
          if ((await mcp.list(instanceId, cwd)).some((item) => item.name === name))
            return { instanceId, label, status: 'skipped' as const }
          await mcp.add(instanceId, server, cwd)
          return { instanceId, label, status: 'copied' as const }
        } catch {
          return { instanceId, label, status: 'failed' as const, error: 'Could not copy server' }
        }
      }),
  )
}
