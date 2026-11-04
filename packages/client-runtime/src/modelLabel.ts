import type { ModelOption } from '@beddcode/contracts'
import { lastUsedModel } from '@beddcode/contracts'
import type { SessionView } from './replica.ts'

/** "claude-sonnet-5-5" -> "Claude Sonnet 5.5", "grok-4.7" -> "Grok 4.7". */
export function prettyModelId(id: string): string {
  const parts: string[] = []
  for (const part of id.split(/[-_]/).filter(Boolean)) {
    const last = parts.at(-1)
    if (/^\d{8}$/.test(part)) continue
    if (/^\d{1,2}$/.test(part) && last !== undefined && /^\d{1,2}(\.\d+)*$/.test(last))
      parts[parts.length - 1] = `${last}.${part}`
    else parts.push(part)
  }
  return parts.map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

/** The model's display name: the agent's own label when it lists it, else a readable form of the id. */
export function modelDisplayName(
  models: readonly ModelOption[],
  id: string | undefined,
  config: SessionView['config'] = [],
): string | undefined {
  if (!id) return undefined
  const listed = models.find((model) => model.id === id)?.label
  if (listed) return listed
  const choice = config
    .find((option) => option.category === 'model')
    ?.choices?.find((c) => c.value === id)
  return choice?.name || prettyModelId(id)
}

/**
 * The model id the session is on, as far as it is known: the session's own record, the agent's
 * model setting, or what the active agent last used here. Undefined only when truly unknown.
 */
export function sessionModelId(
  session: Pick<SessionView, 'model' | 'config' | 'segments' | 'instanceId'>,
): string | undefined {
  const fromConfig = session.config.find((option) => option.category === 'model')?.value
  return (
    session.model ||
    (typeof fromConfig === 'string' ? fromConfig : undefined) ||
    lastUsedModel(session.segments ?? [], session.instanceId)?.model ||
    undefined
  )
}

export function sessionModelLabel(
  session: Pick<SessionView, 'model' | 'config' | 'segments' | 'instanceId'>,
  models: readonly ModelOption[],
): string | undefined {
  return modelDisplayName(models, sessionModelId(session), session.config)
}
