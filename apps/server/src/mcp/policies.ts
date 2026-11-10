import type { McpServer, McpServerPolicy } from '@beddcode/contracts'

/** Which of the server's tools the policy blocks: denied by name, or not in the allow list. */
export function blockedTools(policy: McpServerPolicy | undefined, tools: string[]): string[] {
  if (!policy) return []
  const deny = new Set(policy.toolsDeny ?? [])
  const allow = policy.toolsAllow ? new Set(policy.toolsAllow) : undefined
  return tools.filter((t) => deny.has(t) || (allow !== undefined && !allow.has(t)))
}

/** True when the policy switches the server off for the project. */
export function isDisabled(policy: McpServerPolicy | undefined): boolean {
  return policy?.enabled === false
}

/** Attaches each server its project's policy, when one is set. */
export function withPolicies(
  servers: McpServer[],
  policies: Record<string, McpServerPolicy>,
): McpServer[] {
  return servers.map((s) => {
    const policy = policies[s.name]
    return policy ? { ...s, policy } : s
  })
}

/** A one-line description of a policy, for tooltips and listings. */
export function describePolicy(policy: McpServerPolicy | undefined): string | undefined {
  if (!policy) return undefined
  const parts: string[] = []
  if (policy.enabled === false) parts.push('off')
  if (policy.toolsDeny?.length) parts.push(`deny ${policy.toolsDeny.length}`)
  if (policy.toolsAllow?.length) parts.push(`allow ${policy.toolsAllow.length}`)
  return parts.length ? parts.join(', ') : 'set'
}
