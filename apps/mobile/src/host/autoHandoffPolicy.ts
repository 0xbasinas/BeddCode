import type { HandoffPolicy } from "@beddcode/client-runtime"

export const defaultHandoffPolicy: HandoffPolicy = {
  mode: "off",
  fallback: [],
  maxHops: 3,
  cooldownMs: 30 * 60_000,
}

export type HandoffHostPolicies = Record<
  string,
  { global: HandoffPolicy; projects: Record<string, HandoffPolicy> }
>

export function policyFor(
  hosts: HandoffHostPolicies,
  hostKey: string,
  projectPath?: string,
): HandoffPolicy {
  const settings = hosts[hostKey]
  if (!settings) return defaultHandoffPolicy
  if (projectPath && settings.projects[projectPath]) return settings.projects[projectPath]!
  return settings.global
}
