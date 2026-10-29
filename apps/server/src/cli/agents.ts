import type { ProviderInstance } from '@beddcode/contracts'

/** Preferred when `--agent` is not given: the first of these that is ready, then any that is. */
const PREFERRED = ['claude', 'codex', 'grok']

export function chooseAgent(providers: ProviderInstance[], wanted?: string): ProviderInstance {
  const ready = providers.filter((p) => p.status === 'ready')
  if (wanted) {
    const w = wanted.toLowerCase()
    const found = providers.find((p) => p.id.toLowerCase() === w || p.label.toLowerCase() === w)
    if (!found) {
      throw new Error(`No agent "${wanted}". Available: ${providers.map((p) => p.id).join(', ')}`)
    }
    if (found.status !== 'ready') throw new Error(`${found.label} is not ready on this host`)
    return found
  }
  const pick =
    PREFERRED.map((id) => ready.find((p) => p.id === id || p.kind === id)).find(Boolean) ?? ready[0]
  if (!pick) throw new Error('No agent is ready on this host. Run `beddcode doctor`.')
  return pick
}

/** A permission mode by id or label; an error lists the ones this agent has. */
export function chooseMode(agent: ProviderInstance, wanted: string): string {
  const modes = agent.capabilities.permissionModes
  if (modes.length === 0) return wanted
  const w = wanted.toLowerCase()
  const mode = modes.find((m) => m.id.toLowerCase() === w || m.label.toLowerCase() === w)
  if (!mode) {
    throw new Error(
      `${agent.label} has no mode "${wanted}". Modes: ${modes.map((m) => m.id).join(', ')}`,
    )
  }
  return mode.id
}

export function chooseModel(agent: ProviderInstance, wanted: string): string {
  const models = agent.capabilities.models
  if (!models?.length) return wanted
  const w = wanted.toLowerCase()
  const model = models.find((m) => m.id.toLowerCase() === w || m.label.toLowerCase() === w)
  if (!model) {
    throw new Error(
      `${agent.label} has no model "${wanted}". Models: ${models.map((m) => m.id).join(', ')}`,
    )
  }
  return model.id
}
