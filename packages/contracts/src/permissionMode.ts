import type { PermissionModeOption } from './providers.ts'

/** How much an agent may do without asking, from most restrictive to least. */
export const PERMISSION_LEVELS = ['read-only', 'ask', 'accept-edits', 'full-access'] as const
export type PermissionLevel = (typeof PERMISSION_LEVELS)[number]

const LEVEL_NAMES: Record<PermissionLevel, string> = {
  'read-only': 'Read only',
  ask: 'Ask before tools',
  'accept-edits': 'Accept edits',
  'full-access': 'Full access',
}

type ModeLike = Pick<PermissionModeOption, 'id'> & Partial<PermissionModeOption>

/**
 * Where a mode sits on the scale, from its id, label and danger flag; undefined when it is not
 * recognisable. Ids and labels are the providers' own (`bypassPermissions`, `read-only`, `full`,
 * `approve-all`, ...), so this reads them rather than a list of known agents.
 */
export function permissionLevel(mode: ModeLike | string): PermissionLevel | undefined {
  const m = typeof mode === 'string' ? { id: mode } : mode
  const text = `${m.id} ${m.label ?? ''}`.toLowerCase()
  if (m.dangerous || /bypass|full|yolo|danger|approve-all|always approve|never ask|skip/.test(text))
    return 'full-access'
  if (/plan|read[- ]?only|readonly/.test(text)) return 'read-only'
  if (/accept|auto|edits?\b|write/.test(text) && !/before edits/.test(text)) return 'accept-edits'
  if (/\bask|before|default|approv|manual|normal/.test(text)) return 'ask'
  return undefined
}

export interface PermissionCarry {
  /** The mode to start the target in; undefined when the target has no safe equivalent or no modes. */
  modeId?: string
  /** The level the target starts at, and its display name. */
  level?: PermissionLevel
  label?: string
  /** True when the target has a mode at the same level as the source. */
  exact: boolean
  /** Set when the carried mode is not the same level, or could not be carried. */
  note?: string
}

/**
 * The target's mode that matches the session's current one. The same level when the target has it;
 * otherwise the closest more restrictive one. Never a less restrictive mode: with none at or below
 * the level, nothing is chosen. An unrecognised current mode is treated as "ask".
 */
export function carryPermissionMode(
  current: ModeLike | string | undefined,
  available: PermissionModeOption[],
  targetLabel = 'the new agent',
): PermissionCarry {
  if (current === undefined || available.length === 0) return { exact: false }
  const known = permissionLevel(current)
  const want: PermissionLevel = known ?? 'ask'
  const rank = PERMISSION_LEVELS.indexOf(want)
  const options = available.flatMap((mode) => {
    const level = permissionLevel(mode)
    return level ? [{ mode, level, rank: PERMISSION_LEVELS.indexOf(level) }] : []
  })
  const currentId = typeof current === 'string' ? current : current.id
  // Among equals, keep the same id when there is one.
  const best = options
    .filter((o) => o.rank <= rank)
    .sort(
      (a, b) =>
        b.rank - a.rank || Number(b.mode.id === currentId) - Number(a.mode.id === currentId),
    )[0]
  const wantName = LEVEL_NAMES[want]
  if (!best) {
    return {
      exact: false,
      level: want,
      note: `${wantName} isn't available in ${targetLabel}, and it has nothing as restrictive; using its default.`,
    }
  }
  const exact = best.rank === rank
  const base = { modeId: best.mode.id, level: best.level, label: LEVEL_NAMES[best.level], exact }
  if (!known)
    return {
      ...base,
      note: `Couldn't tell what "${currentId}" allows; using ${LEVEL_NAMES[best.level]} in ${targetLabel}.`,
    }
  if (exact) return base
  return {
    ...base,
    note: `${wantName} isn't available in ${targetLabel}; using ${LEVEL_NAMES[best.level]}.`,
  }
}
