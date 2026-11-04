import type { SessionEvent, SessionSegment, StoredEvent } from './events.ts'

/** Fold session identity events in log order. A creation event supplies the legacy segment. */
export function projectSegmentEvent(
  segments: SessionSegment[],
  event: SessionEvent,
): SessionSegment[] {
  if (event.type === 'session.created')
    return [
      { provider: event.instanceId, model: event.model, effort: event.effort, startedAt: event.at },
    ]
  if (!segments.length) return segments
  const last = segments.length - 1
  switch (event.type) {
    case 'session.model':
      return segments.map((segment, i) =>
        i === last ? { ...segment, model: event.model, effort: event.effort } : segment,
      )
    case 'session.provider-session':
      return segments.map((segment, i) =>
        i === last ? { ...segment, nativeSessionId: event.providerSessionId } : segment,
      )
    case 'session.switched':
      return [
        ...segments.map((segment, i) => (i === last ? { ...segment, endedAt: event.at } : segment)),
        {
          provider: event.instanceId,
          model: event.model,
          effort: event.effort,
          startedAt: event.at,
          handoffContext: event.handoff,
        },
      ]
    default:
      return segments
  }
}

export function projectSessionSegments(events: readonly StoredEvent[]): SessionSegment[] {
  return events.reduce(
    (segments, { event }) => projectSegmentEvent(segments, event),
    [] as SessionSegment[],
  )
}

/**
 * The model and effort a provider last used in this session, or undefined when it has not been
 * used yet. A provider that is not active again starts from this, never from another agent's choice.
 */
export function lastUsedModel(
  segments: readonly SessionSegment[],
  provider: string,
): { model?: string; effort?: string } | undefined {
  const found = segments.findLast((segment) => segment.provider === provider)
  return found && { model: found.model, effort: found.effort }
}
