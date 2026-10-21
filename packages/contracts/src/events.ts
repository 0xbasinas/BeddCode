import { z } from 'zod'

/**
 * The single internal event vocabulary. Every provider adapter converts its native protocol
 * into these; the store, server and UI know nothing about provider specifics.
 */
const Base = z.object({
  sessionId: z.string(),
  turnId: z.string().optional(),
  at: z.number().int().describe('epoch ms'),
})

export const SessionEvent = z.discriminatedUnion('type', [
  Base.extend({
    type: z.literal('session.created'),
    title: z.string(),
    cwd: z.string(),
    instanceId: z.string(),
    permissionMode: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    /** Repository root (or folder) the session belongs to, for grouping. Equals `cwd` outside worktrees. */
    projectPath: z.string().optional(),
    branch: z.string().optional(),
    /** Set when the session works in a worktree created for it. */
    worktree: z.object({ baseBranch: z.string() }).optional(),
  }),
  /** The provider's own session id, kept so a stopped session can be resumed later. */
  Base.extend({ type: z.literal('session.provider-session'), providerSessionId: z.string() }),
  /** Permission modes the agent itself reports for this session (ACP agents). */
  Base.extend({
    type: z.literal('session.modes'),
    modes: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        description: z.string().optional(),
        dangerous: z.boolean().optional(),
      }),
    ),
    currentModeId: z.string().optional(),
  }),
  Base.extend({ type: z.literal('turn.started') }),
  Base.extend({
    type: z.literal('message.delta'),
    role: z.enum(['user', 'assistant']),
    text: z.string(),
    /** Files the user attached to this message (user messages only). */
    attachments: z.array(z.object({ name: z.string(), path: z.string() })).optional(),
  }),
  Base.extend({
    type: z.literal('tool.started'),
    toolId: z.string(),
    kind: z.enum(['command', 'read', 'edit', 'search', 'other']),
    title: z.string(),
  }),
  Base.extend({
    type: z.literal('tool.completed'),
    toolId: z.string(),
    ok: z.boolean(),
    output: z.string().optional(),
  }),
  Base.extend({
    type: z.literal('diff'),
    path: z.string(),
    added: z.number().int(),
    removed: z.number().int(),
    patch: z.string(),
  }),
  Base.extend({
    type: z.literal('approval.requested'),
    requestId: z.string(),
    title: z.string(),
    detail: z.string().optional(),
    /** The provider's own option ids, passed through unchanged. */
    options: z.array(
      z.object({ id: z.string(), label: z.string(), kind: z.enum(['allow', 'deny', 'other']) }),
    ),
  }),
  Base.extend({
    type: z.literal('approval.resolved'),
    requestId: z.string(),
    optionId: z.string(),
  }),
  Base.extend({
    type: z.literal('turn.completed'),
    reason: z.enum(['done', 'cancelled', 'error']),
  }),
  Base.extend({ type: z.literal('error'), message: z.string() }),
])
export type SessionEvent = z.infer<typeof SessionEvent>

/** An event as stored in the log: carries the host-wide monotonic sequence number. */
export const StoredEvent = z.object({ seq: z.number().int().nonnegative(), event: SessionEvent })
export type StoredEvent = z.infer<typeof StoredEvent>
