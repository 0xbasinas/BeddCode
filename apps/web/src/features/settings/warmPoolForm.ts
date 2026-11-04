import { WARM_POOL_LIMITS, type WarmPoolChange, type WarmPoolSettings } from '@beddcode/contracts'

export interface WarmPoolDraft {
  size: string
  memoryCapMb: string
  idleTimeoutMinutes: string
}

export function draftFromSettings(settings: WarmPoolSettings): WarmPoolDraft {
  return {
    size: String(settings.size),
    memoryCapMb: String(settings.memoryCapMb),
    idleTimeoutMinutes: String(settings.idleTimeoutMinutes),
  }
}

const FIELDS = [
  ['size', 'Pool size'],
  ['memoryCapMb', 'Memory cap'],
  ['idleTimeoutMinutes', 'Idle timeout'],
] as const

/** The numbers that differ from the saved ones, or the first problem in plain words. */
export function changeFromDraft(
  draft: WarmPoolDraft,
  saved: WarmPoolSettings,
): { change: WarmPoolChange } | { error: string } {
  const change: Record<string, number> = {}
  for (const [key, label] of FIELDS) {
    const text = draft[key].trim()
    const value = Number(text)
    const { min, max } = WARM_POOL_LIMITS[key]
    if (!text || !Number.isInteger(value) || value < min || value > max)
      return { error: `${label} must be a whole number from ${min} to ${max}.` }
    if (value !== saved[key]) change[key] = value
  }
  return { change }
}
