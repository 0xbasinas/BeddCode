/**
 * The tiny dot on the Environment icon while its card is closed: a warning while the host is
 * reconnecting, otherwise a quiet mark when the session has uncommitted changes, else nothing.
 */
export type EnvironmentHint = 'warn' | 'changes'

export function environmentHint(
  connected: boolean,
  stats: { added: number; removed: number },
): EnvironmentHint | undefined {
  if (!connected) return 'warn'
  if (stats.added + stats.removed > 0) return 'changes'
  return undefined
}
