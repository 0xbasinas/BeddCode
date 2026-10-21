import type { AcpAgentSummary, RegistryEntry, RpcParams } from '@beddcode/contracts'
import {
  RESERVED_IDS,
  launchFor,
  type AcpAgentConfig,
  type AcpAgentStore,
  type AcpRegistry,
} from '@beddcode/provider-acp'

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

const summary = (a: AcpAgentConfig): AcpAgentSummary => ({
  id: a.id,
  label: a.label,
  command: a.command,
  args: a.args,
  registryId: a.registryId,
})

type CustomAgent = Extract<RpcParams<'agents.add'>, { command: string }>

/** Configured ACP agents plus the public registry they can be added from. */
export class AgentCatalog {
  constructor(
    private readonly store: AcpAgentStore,
    private readonly registry: AcpRegistry,
    /** Called after the set of agents changes so cached provider detection is refreshed. */
    private readonly onChange: () => void = () => {},
  ) {}

  list(): AcpAgentSummary[] {
    return this.store.list().map(summary)
  }

  async add(params: RpcParams<'agents.add'>): Promise<AcpAgentSummary> {
    const config =
      'registryId' in params ? await this.fromRegistry(params.registryId) : this.fromCommand(params)
    const saved = this.store.put(config)
    this.onChange()
    return summary(saved)
  }

  remove(id: string): { removed: boolean } {
    const removed = this.store.remove(id)
    if (removed) this.onChange()
    return { removed }
  }

  async searchRegistry(query: string | undefined): Promise<RegistryEntry[]> {
    const agents = await this.registry.search(query ?? '')
    return agents.map((a) => {
      const launch = launchFor(a)
      return {
        id: a.id,
        name: a.name,
        version: a.version,
        description: a.description,
        icon: a.icon,
        installable: launch.ok,
        reason: launch.ok ? undefined : launch.reason,
      }
    })
  }

  private async fromRegistry(registryId: string) {
    const agent = await this.registry.get(registryId)
    if (!agent) throw new Error(`Not in the ACP registry: ${registryId}`)
    const launch = launchFor(agent)
    if (!launch.ok) throw new Error(`${agent.name}: ${launch.reason}`)
    // Claude Code and Codex have native adapters; keep their registry entries from colliding
    // with the reserved ids.
    const id = RESERVED_IDS.has(registryId) ? `${registryId}-acp` : registryId
    return {
      id,
      label: agent.name,
      command: launch.launch.command,
      args: launch.launch.args,
      env: launch.launch.env,
      registryId,
    }
  }

  private fromCommand(p: CustomAgent) {
    const base = slug(p.label) || 'agent'
    const taken = new Set([...this.store.list().map((a) => a.id), ...RESERVED_IDS])
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    return { id, label: p.label, command: p.command, args: p.args ?? [], env: p.env ?? {} }
  }
}
