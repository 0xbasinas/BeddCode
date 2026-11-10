import { createLogger, resolveExecutable, spawnTransport } from '@beddcode/shared'
import type { KnownAgent, AcpAgentSummary, RegistryEntry, RpcParams } from '@beddcode/contracts'
import {
  RESERVED_IDS,
  installBinary,
  launchFor,
  planInstall,
  removeInstall,
  type AcpAgentConfig,
  type AcpAgentStore,
  detectKnownAgents,
  type AcpRegistry,
  type InstallOptions,
  type RegistryAgent,
  withAcpAgent,
  safeAdvertised,
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
  env: a.env,
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

  async inspect(id: string, cwd = process.cwd()) {
    const config = this.store.get(id)
    if (!config) throw new Error(`Unknown agent: ${id}`)
    const executable = resolveExecutable(config.command, { ...process.env, ...config.env })
    if (!executable) throw new Error(`Executable not found: ${config.command}`)
    if (
      /^(npx|npm|pnpm|yarn|bunx)(\.cmd|\.exe)?$/i.test(config.command.split(/[\\/]/).at(-1) ?? '')
    )
      throw new Error(
        'This agent uses a package runner. Configure its installed ACP executable to inspect it directly.',
      )
    const log = createLogger('acp-inspect')
    const transport = spawnTransport(
      executable,
      config.args,
      {
        cwd,
        env: { ...process.env, ...config.env, NO_BROWSER: 'true' },
      },
      log,
    )
    return withAcpAgent(transport, log, config.label, async (_rpc, caps, init) => ({
      command: config.command,
      args: config.args,
      executable,
      cwd,
      checkedAt: Date.now(),
      protocolVersion: init.protocolVersion!,
      name: init.agentInfo?.title ?? init.agentInfo?.name,
      version: init.agentInfo?.version,
      authMethods: init.authMethods?.length ?? 0,
      clientProfile: 'restricted-diagnostic' as const,
      raw: safeAdvertised({ agentCapabilities: init.agentCapabilities, _meta: init._meta }),
      features: {
        steering: init._meta?.steering?.supported === true,
        load: caps.loadSession === true,
        resume: !!caps.sessionCapabilities?.resume,
        list: !!caps.sessionCapabilities?.list,
        close: !!caps.sessionCapabilities?.close,
        images: caps.promptCapabilities?.image === true,
        audio: caps.promptCapabilities?.audio === true,
        embeddedContext: caps.promptCapabilities?.embeddedContext === true,
        mcpHttp: caps.mcpCapabilities?.http === true,
        mcpSse: caps.mcpCapabilities?.sse === true,
      },
    }))
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

  async update(p: RpcParams<'agents.update'>): Promise<AcpAgentSummary> {
    const existing = this.store.get(p.id)
    if (!existing) throw new Error(`Unknown agent: ${p.id}`)
    const saved = this.store.put({
      ...existing,
      label: p.label.trim(),
      command: p.command.trim(),
      args: p.args,
      env: p.env,
    })
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

  /** The well-known ACP agents, with whether each is installed here and already added. */
  known(resolve: (command: string) => string | null = resolveExecutable): KnownAgent[] {
    const added = new Set(this.store.list().map((a) => a.command.toLowerCase()))
    return detectKnownAgents(resolve).map((a) => ({
      id: a.id,
      name: a.name,
      command: a.command,
      args: a.args,
      installed: a.installed,
      missing: a.missing,
      added: added.has(a.command.toLowerCase()),
    }))
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
    // Claude Code, Codex and Grok have native adapters; keep their registry entries from colliding
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
