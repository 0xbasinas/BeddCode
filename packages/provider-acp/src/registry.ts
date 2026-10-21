import { z } from 'zod'

export const REGISTRY_URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'

const Distribution = z.object({
  npx: z
    .object({
      package: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  uvx: z
    .object({
      package: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
    })
    .optional(),
  binary: z.record(z.string(), z.unknown()).optional(),
})

export const RegistryAgent = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  description: z.string().default(''),
  repository: z.string().optional(),
  website: z.string().optional(),
  icon: z.string().optional(),
  distribution: Distribution,
})
export type RegistryAgent = z.infer<typeof RegistryAgent>

const RegistryFile = z.object({ agents: z.array(RegistryAgent) })

export interface LaunchSpec {
  command: string
  args: string[]
  env: Record<string, string>
}

export type LaunchResult = { ok: true; launch: LaunchSpec } | { ok: false; reason: string }

/**
 * How to start a registry agent without downloading anything ourselves: `npx` and `uvx` packages
 * are fetched and run by their own tools at the exact version the registry lists. Binary-only
 * agents need a downloader and are reported as unsupported for now.
 */
export function launchFor(agent: RegistryAgent): LaunchResult {
  const { npx, uvx } = agent.distribution
  if (npx) {
    return {
      ok: true,
      launch: {
        command: 'npx',
        args: ['-y', npx.package, ...(npx.args ?? [])],
        env: npx.env ?? {},
      },
    }
  }
  if (uvx) {
    return {
      ok: true,
      launch: { command: 'uvx', args: [uvx.package, ...(uvx.args ?? [])], env: uvx.env ?? {} },
    }
  }
  return { ok: false, reason: 'Binary-only agent: automatic download is not supported yet' }
}

export interface RegistryOptions {
  fetch?: typeof fetch
  url?: string
  ttlMs?: number
  now?: () => number
}

/** Fetches the public ACP registry and keeps it for a while; failures fall back to the last copy. */
export class AcpRegistry {
  private cache: { at: number; agents: RegistryAgent[] } | null = null

  constructor(private readonly options: RegistryOptions = {}) {}

  async list(): Promise<RegistryAgent[]> {
    const now = this.options.now?.() ?? Date.now()
    const ttl = this.options.ttlMs ?? 60 * 60_000
    if (this.cache && now - this.cache.at < ttl) return this.cache.agents
    try {
      const res = await (this.options.fetch ?? fetch)(this.options.url ?? REGISTRY_URL, {
        signal: AbortSignal.timeout(15_000),
      })
      if (!res.ok) throw new Error(`registry returned ${res.status}`)
      const agents = RegistryFile.parse(await res.json()).agents
      this.cache = { at: now, agents }
      return agents
    } catch (err) {
      if (this.cache) return this.cache.agents
      throw err
    }
  }

  async search(query: string): Promise<RegistryAgent[]> {
    const q = query.trim().toLowerCase()
    const all = await this.list()
    if (!q) return all
    return all.filter((a) => `${a.id} ${a.name} ${a.description}`.toLowerCase().includes(q))
  }

  async get(id: string): Promise<RegistryAgent | undefined> {
    return (await this.list()).find((a) => a.id === id)
  }
}
