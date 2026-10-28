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

export const PlanStep = z.object({
  text: z.string(),
  status: z.enum(['pending', 'in-progress', 'completed']),
})
export type PlanStep = z.infer<typeof PlanStep>

/** A question the agent asks the user mid-turn (Claude's AskUserQuestion, Codex's request_user_input). */
export const QuestionSpec = z.object({
  id: z.string(),
  header: z.string().optional(),
  question: z.string(),
  /** Suggested answers; absent for a free-text question. */
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
  multiSelect: z.boolean().optional(),
  /** Whether the user may type an answer instead of picking an option. */
  allowOther: z.boolean().optional(),
  secret: z.boolean().optional(),
})
export type QuestionSpec = z.infer<typeof QuestionSpec>

/** A slash command, skill or subagent the agent offers in the composer. */
export const SlashCommand = z.object({
  name: z.string(),
  description: z.string().optional(),
  /** Hint for the argument, e.g. <file>. */
  hint: z.string().optional(),
  kind: z.enum(['command', 'skill', 'agent']).optional(),
})
export type SlashCommand = z.infer<typeof SlashCommand>

/** A setting the agent itself offers for a session (its model, its thinking level, ...). */
export const ConfigOption = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  /** model, thought_level, mode, ... as the agent classifies it. */
  category: z.string().optional(),
  type: z.enum(['select', 'boolean']),
  value: z.union([z.string(), z.boolean()]),
  choices: z
    .array(
      z.object({
        value: z.string(),
        name: z.string(),
        description: z.string().optional(),
        group: z.string().optional(),
      }),
    )
    .optional(),
})
export type ConfigOption = z.infer<typeof ConfigOption>

/** One file a turn changed (see `turn.changes`). */
export const TurnChangedFile = z.object({
  path: z.string(),
  status: z.enum(['A', 'M', 'D', 'R']),
  oldPath: z.string().optional(),
  added: z.number().int().nonnegative(),
  removed: z.number().int().nonnegative(),
  /** Binary content: no line counts. */
  binary: z.boolean().optional(),
})
export type TurnChangedFile = z.infer<typeof TurnChangedFile>

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
    /** Uses a host-managed session folder and belongs to no project. */
    projectless: z.boolean().optional(),
    branch: z.string().optional(),
    /** Set when the session works in a worktree created for it. */
    worktree: z.object({ baseBranch: z.string() }).optional(),
    /** Set when this session continues another one's history. */
    forkedFrom: z.object({ sessionId: z.string(), title: z.string().optional() }).optional(),
    /** True when the conversation was started outside BeddCode and imported. */
    imported: z.boolean().optional(),
    /** Set when another session's agent started this one (see agent tools). */
    parent: z
      .object({
        sessionId: z.string(),
        depth: z.number().int(),
        /** The caller's own id for this start, so repeating the call finds this session again. */
        requestId: z.string().optional(),
      })
      .optional(),
    /** The agent may start and manage sessions of its own through BeddCode's tools. */
    agentTools: z.boolean().optional(),
    /** The agent may use the desktop app's browser pane through BeddCode's browser tools. */
    browserTools: z.boolean().optional(),
    /** The agent may read and draw on the host's design canvases through BeddCode's design tools. */
    designTools: z.boolean().optional(),
    /** Set when a schedule started this session. */
    schedule: z.object({ id: z.string(), name: z.string() }).optional(),
  }),
  /** The provider's own session id, kept so a stopped session can be resumed later. */
  Base.extend({ type: z.literal('session.provider-session'), providerSessionId: z.string() }),
  Base.extend({ type: z.literal('session.renamed'), title: z.string().trim().min(1).max(120) }),
  /** The user moved the session to, or back out of, the sidebar's Done section. */
  Base.extend({ type: z.literal('session.done'), done: z.boolean() }),
  /** A session started by another agent says how its task ended (its report_result tool). */
  Base.extend({
    type: z.literal('session.result'),
    status: z.enum(['done', 'blocked', 'failed']),
    summary: z.string(),
  }),
  /** The user deleted the session; devices drop it. Its earlier events are removed from the log. */
  Base.extend({ type: z.literal('session.deleted') }),
  /** The user pinned the session to the top of the sidebar, or unpinned it. */
  Base.extend({ type: z.literal('session.pinned'), pinned: z.boolean() }),
  /** The model and reasoning effort in use changed (set by the user during the session). */
  Base.extend({
    type: z.literal('session.model'),
    model: z.string().optional(),
    effort: z.string().optional(),
  }),
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
    /** The arguments the agent called it with, as pretty JSON (capped), when it says. */
    input: z.string().optional(),
    /** Files the tool touches, in full, when the agent says. */
    paths: z.array(z.string()).optional(),
  }),
  /** The agent said more about a tool it already announced: what kind it is, a better title. */
  Base.extend({
    type: z.literal('tool.updated'),
    toolId: z.string(),
    kind: z.enum(['command', 'read', 'edit', 'search', 'other']).optional(),
    title: z.string().optional(),
    input: z.string().optional(),
    paths: z.array(z.string()).optional(),
  }),
  Base.extend({
    type: z.literal('tool.completed'),
    toolId: z.string(),
    ok: z.boolean(),
    output: z.string().optional(),
    /**
     * Whether the agent asked the user before running it. `not-asked` means the agent's own policy
     * let it run without a prompt (read-only commands, an earlier "allow for this session").
     * Absent when the provider does not say.
     */
    approval: z.enum(['asked', 'not-asked']).optional(),
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
    /** The tool call this request is about, when the provider says. */
    toolId: z.string().optional(),
    title: z.string(),
    detail: z.string().optional(),
    /** A plan to approve (markdown), when the agent leaves plan mode and asks to start. */
    plan: z.string().optional(),
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
  /** A message typed while the agent was busy, waiting for the next turn. */
  Base.extend({
    type: z.literal('prompt.queued'),
    queueId: z.string(),
    text: z.string(),
    attachments: z.array(z.object({ name: z.string(), path: z.string() })).optional(),
  }),
  Base.extend({
    type: z.literal('prompt.dequeued'),
    queueId: z.string(),
    reason: z.enum(['sent', 'steered', 'cancelled']),
  }),
  /** The agent's own to-do list or plan; each event replaces the previous one. */
  Base.extend({
    type: z.literal('plan.updated'),
    steps: z.array(PlanStep),
    explanation: z.string().optional(),
  }),
  Base.extend({
    type: z.literal('question.requested'),
    requestId: z.string(),
    questions: z.array(QuestionSpec),
  }),
  /** answers maps a question id to what was chosen or typed; absent when it was dismissed. */
  Base.extend({
    type: z.literal('question.resolved'),
    requestId: z.string(),
    answers: z.record(z.string(), z.array(z.string())).optional(),
  }),
  /** The agent's own per-session settings; each event replaces the previous list. */
  Base.extend({ type: z.literal('session.config'), options: z.array(ConfigOption) }),
  /** Commands and skills available right now; each event replaces the previous list. */
  Base.extend({ type: z.literal('session.commands'), commands: z.array(SlashCommand) }),
  Base.extend({
    type: z.literal('turn.completed'),
    reason: z.enum(['done', 'cancelled', 'error']),
    /** Explains an interrupted turn, such as a host restart. */
    message: z.string().optional(),
  }),
  /**
   * What a turn used, as the agent reports it: the tokens (and cost, when it says) added by that
   * turn, per model. Summed over time for the Usage page.
   */
  Base.extend({
    type: z.literal('session.usage'),
    model: z.string().optional(),
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
  }),
  /** How full the agent's context window is, as the agent reports it (ACP `usage_update`). */
  Base.extend({
    type: z.literal('session.context'),
    used: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
  }),
  /**
   * What a finished turn changed in the session's folder, from git snapshots the host took when
   * the turn started and ended (any edit counts: the agent's own edit tools, commands, generated
   * files). `before` and `after` are snapshot commits kept under hidden refs.
   */
  Base.extend({
    type: z.literal('turn.changes'),
    before: z.string(),
    after: z.string(),
    files: z.array(TurnChangedFile),
    /** More files changed than are listed. */
    truncated: z.boolean().optional(),
  }),
  /** The user undid a turn's changes; the folder is back at that turn's `before` snapshot. */
  Base.extend({ type: z.literal('turn.reverted'), after: z.string() }),
  Base.extend({ type: z.literal('error'), message: z.string() }),
])
export type SessionEvent = z.infer<typeof SessionEvent>

/** An event as stored in the log: carries the host-wide monotonic sequence number. */
export const StoredEvent = z.object({ seq: z.number().int().nonnegative(), event: SessionEvent })
export type StoredEvent = z.infer<typeof StoredEvent>
