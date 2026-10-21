import type { AcpAgentSummary, RegistryEntry, RpcParams } from '@beddcode/contracts'
import {
  RESERVED_IDS,
  installBinary,
  launchFor,
  planInstall,
  removeInstall,
  type AcpAgentConfig,
  type AcpAgentStore,
  type AcpRegistry,
  type InstallOptions,
  type RegistryAgent,
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
    /** Where downloaded agents live, and how to download (tests replace the latter). */
    private readonly installs?: Pick<InstallOptions, 'root'> & Partial<InstallOptions>,
  ) {}

  private planFor(agent: RegistryAgent) {
    const run = launchFor(agent)
    return planInstall(agent, run.ok ? run.launch : undefined, this.installs?.platform)
  }

  list(): AcpAgentSummary[] {
    return this.store.list().map(summary)
  }

  async add(params: RpcParams<'agents.add'>): Promise<AcpAgentSummary> {
    const config =
      'registryId' in params
        ? await this.fromRegistry(params.registryId, params.acceptDownload === true)
        : this.fromCommand(params)
    const saved = this.store.put(config)
    this.onChange()
    return summary(saved)
  }

  async remove(id: string): Promise<{ removed: boolean }> {
    const config = this.store.get(id)
    const removed = this.store.remove(id)
    if (removed) {
      // A program we downloaded goes away with its agent.
      if (config?.registryId && this.installs)
        await removeInstall(this.installs.root, config.registryId)
      this.onChange()
    }
    return { removed }
  }

  async searchRegistry(query: string | undefined): Promise<RegistryEntry[]> {
    const agents = await this.registry.search(query ?? '')
    return agents.map((a): RegistryEntry => {
      const plan = this.planFor(a)
      return {
        id: a.id,
        name: a.name,
        version: a.version,
        description: a.description,
        icon: a.icon,
        installable: plan.type !== 'unavailable',
        reason: plan.type === 'unavailable' ? plan.reason : undefined,
        download:
          plan.type === 'download' ? { host: plan.host, verified: plan.verified } : undefined,
      }
    })
  }

  private async fromRegistry(registryId: string, acceptDownload: boolean) {
    const agent = await this.registry.get(registryId)
    if (!agent) throw new Error(`Not in the ACP registry: ${registryId}`)
    const plan = this.planFor(agent)
    if (plan.type === 'unavailable') throw new Error(`${agent.name}: ${plan.reason}`)
    if (plan.type === 'download') {
      if (!this.installs)
        throw new Error(`${agent.name} needs a download, which is not set up on this host`)
      // Fetching a program is the user's call: the app asks first and passes acceptDownload.
      if (!acceptDownload) {
        throw new Error(`${agent.name} downloads a program from ${plan.host}. Confirm to continue.`)
      }
    }
    const launch =
      plan.type === 'run'
        ? { ok: true as const, launch: plan.launch }
        : { ok: true as const, launch: await installBinary(agent, this.installs!) }
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
