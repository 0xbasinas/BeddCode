import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ProviderAdapter, ProviderMcp } from '@beddcode/provider-core'

/** Secrets are separate from agent configs; those contain only environment variable names. */
export async function protectMcpSecrets(
  home: string,
  env: Record<string, string>,
  adapters: ProviderAdapter[],
) {
  const file = join(home, 'mcp-secrets.json')
  let secrets: Record<string, string> = {}
  try {
    secrets = JSON.parse(await readFile(file, 'utf8')) as Record<string, string>
    await chmod(file, 0o600)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  Object.assign(env, secrets)
  let queue = Promise.resolve()
  const save = async () => {
    const temp = `${file}.tmp`
    await writeFile(temp, JSON.stringify(secrets), { mode: 0o600 })
    await chmod(temp, 0o600)
    await rename(temp, file)
  }
  for (const adapter of adapters) {
    if (!adapter.mcp || (adapter.kind !== 'claude' && adapter.kind !== 'codex')) continue
    const mcp = adapter.mcp
    const protectedMcp: ProviderMcp = {
      ...mcp,
      async list(instanceId, cwd) {
        try {
          const servers = await mcp.list(instanceId, cwd)
          const redact = (text: string) =>
            Object.values(secrets)
              .filter(Boolean)
              .reduce((value, secret) => value.split(secret).join('••••'), text)
          return servers.map((server) => ({
            ...server,
            target: redact(server.target),
            ...(server.error ? { error: redact(server.error) } : {}),
          }))
        } catch {
          throw new Error('Could not list MCP servers')
        }
      },
      async add(instanceId, server, cwd) {
        const task = async () => {
          const headers = server.headers ?? {}
          if (server.transport === 'stdio' && (Object.keys(headers).length || server.bearerToken))
            throw new Error('Headers only apply to remote MCP servers')
          if (
            server.bearerToken &&
            Object.keys(headers).some((name) => name.toLowerCase() === 'authorization')
          )
            throw new Error('Use either a bearer token or an Authorization header')
          const prefix = `BEDDCODE_MCP_${Buffer.from(
            `${adapter.kind}:${instanceId}:${server.name}:${server.scope ?? ''}:${cwd ?? ''}`,
          )
            .toString('hex')
            .toUpperCase()}_`
          const next: Record<string, string> = {}
          const refs: Record<string, string> = {}
          for (const [name, value] of Object.entries(headers)) {
            const variable = prefix + Buffer.from(name.toLowerCase()).toString('hex').toUpperCase()
            next[variable] = value
            refs[name] = adapter.kind === 'claude' ? `\${${variable}}` : variable
          }
          let token: string | undefined
          if (server.bearerToken) {
            const variable = prefix + 'TOKEN'
            next[variable] = server.bearerToken
            token = adapter.kind === 'claude' ? `\${${variable}}` : variable
          }
          // Persist before adding so a config never points at secrets that were not saved.
          Object.assign(secrets, next)
          await save()
          Object.assign(env, next)
          try {
            await mcp.add(instanceId, { ...server, headers: refs, bearerToken: token }, cwd)
          } catch {
            throw new Error(
              'Could not add MCP server; check the server configuration and agent CLI',
            )
          }
        }
        const result = queue.then(task)
        queue = result.catch(() => {})
        await result
      },
    }
    Object.assign(adapter, { mcp: protectedMcp })
  }
}
