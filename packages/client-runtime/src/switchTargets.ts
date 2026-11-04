import type { ProviderInstance } from '@beddcode/contracts'

export type SwitchTarget = { provider: ProviderInstance; ready: boolean; reason?: string }

const reasons: Record<ProviderInstance['status'], string | undefined> = {
  ready: undefined,
  'needs-sign-in': 'Not signed in',
  'not-installed': 'Not installed',
  error: 'Not available',
}

/** Other agents a session can switch to, with why an unready one cannot be picked. */
export function switchTargets(providers: ProviderInstance[], currentId: string): SwitchTarget[] {
  return providers
    .filter((p) => p.id !== currentId)
    .map((provider) => ({
      provider,
      ready: provider.status === 'ready',
      reason: reasons[provider.status],
    }))
}

/** The first ready agent other than the current one; undefined when there is none. */
export function defaultSwitchTarget(
  providers: ProviderInstance[],
  currentId: string,
): ProviderInstance | undefined {
  return switchTargets(providers, currentId).find((t) => t.ready)?.provider
}

/** Finds an agent by id or label; says why when it cannot be switched to. */
export function findSwitchTarget(
  providers: ProviderInstance[],
  currentId: string,
  name: string,
): { provider: ProviderInstance } | { error: string } {
  const wanted = name.trim().toLowerCase()
  const match = switchTargets(providers, currentId).find(
    (t) => t.provider.id.toLowerCase() === wanted || t.provider.label.toLowerCase() === wanted,
  )
  if (!match) return { error: 'No agent matches that name' }
  if (!match.ready) return { error: `${match.provider.label} is not ready: ${match.reason}` }
  return { provider: match.provider }
}
