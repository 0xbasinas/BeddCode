import { z } from 'zod'

/** When a schedule fires: every N minutes, or a five-field cron expression in the host's time. */
export const ScheduleTrigger = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('every'), minutes: z.number().int().min(1).max(10_080) }),
  z.object({ kind: z.literal('cron'), expr: z.string().trim().min(9).max(120) }),
])
export type ScheduleTrigger = z.infer<typeof ScheduleTrigger>

/** What a schedule does: start a fresh session, or send a heartbeat to one that exists. */
export const ScheduleTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('new'),
    instanceId: z.string(),
    cwd: z.string().optional(),
    projectless: z.boolean().optional(),
    permissionMode: z.string().optional(),
    model: z.string().optional(),
    effort: z.string().optional(),
    /** Each run works in a new worktree of the folder's repository. */
    worktree: z.boolean().optional(),
  }),
  z.object({ kind: z.literal('session'), sessionId: z.string() }),
])
export type ScheduleTarget = z.infer<typeof ScheduleTarget>

export const ScheduleInput = z.object({
  /** Set to update a schedule; left out to create one. */
  id: z.string().optional(),
  name: z.string().trim().min(1).max(80),
  prompt: z.string().trim().min(1).max(20_000),
  trigger: ScheduleTrigger,
  target: ScheduleTarget,
  paused: z.boolean().optional(),
})
export type ScheduleInput = z.infer<typeof ScheduleInput>

export const Schedule = ScheduleInput.extend({
  id: z.string(),
  paused: z.boolean(),
  createdAt: z.number().int(),
  lastRunAt: z.number().int().optional(),
  /** When it fires next; absent while paused or when the cron expression never matches. */
  nextRunAt: z.number().int().optional(),
})
export type Schedule = z.infer<typeof Schedule>

export const ScheduleRun = z.object({
  id: z.string(),
  scheduleId: z.string(),
  startedAt: z.number().int(),
  endedAt: z.number().int().optional(),
  status: z.enum(['running', 'done', 'error', 'cancelled', 'skipped']),
  /** The session the run worked in. */
  sessionId: z.string().optional(),
  /** Why it was skipped or failed. */
  note: z.string().optional(),
  manual: z.boolean().optional(),
})
export type ScheduleRun = z.infer<typeof ScheduleRun>

/** Which happenings a device wants on its lock screen. */
export const AlertEvents = z.object({
  /** An agent finished its turn. */
  turnDone: z.boolean(),
  /** An agent is waiting for an approval or an answer. */
  needsYou: z.boolean(),
  /** A turn stopped with an error. */
  error: z.boolean(),
  /** A scheduled run finished. */
  schedule: z.boolean(),
})
export type AlertEvents = z.infer<typeof AlertEvents>

export const DEFAULT_ALERT_EVENTS: AlertEvents = {
  turnDone: true,
  needsYou: true,
  error: true,
  schedule: true,
}

export const AlertKind = z.enum(['turnDone', 'needsYou', 'error', 'schedule'])
export type AlertKind = z.infer<typeof AlertKind>

/** What the host tells a phone. */
export const AlertPayload = z.object({
  kind: AlertKind,
  title: z.string(),
  body: z.string(),
  sessionId: z.string().optional(),
  hostId: z.string().optional(),
})
export type AlertPayload = z.infer<typeof AlertPayload>

/** A phone that asked for push alerts from this host. */
export const PushRegistration = z.object({
  /** The paired device it belongs to; removed with that device. Absent for this machine. */
  deviceId: z.string().optional(),
  /** Expo push token (`ExponentPushToken[...]`). */
  token: z.string(),
  deviceName: z.string().optional(),
  platform: z.enum(['android', 'ios']).optional(),
  events: AlertEvents,
  createdAt: z.number().int(),
})
export type PushRegistration = z.infer<typeof PushRegistration>

/** Whether the Telegram bot is running and how many chats may use it. */
export const TelegramStatus = z.object({
  connected: z.boolean(),
  botName: z.string().optional(),
  chats: z.number(),
  /** A one-time code to send the bot as `/pair <code>`, while one is open. */
  pairCode: z.string().optional(),
})
export type TelegramStatus = z.infer<typeof TelegramStatus>

/** Host-wide alert delivery settings. */
export const AlertSettings = z.object({
  /**
   * An ntfy topic address (https://ntfy.sh/your-topic or a self-hosted one). The ntfy app on a
   * phone then shows alerts with nothing else to set up.
   */
  ntfyUrl: z.string().url().optional(),
  ntfyEvents: AlertEvents.optional(),
})
export type AlertSettings = z.infer<typeof AlertSettings>

/** An alert the host sent recently, for the settings page and for checking it works. */
export const SentAlert = AlertPayload.extend({
  at: z.number().int(),
  /** Where it went: `expo:<device>` or `ntfy`, with the outcome. */
  deliveries: z.array(z.object({ to: z.string(), ok: z.boolean(), error: z.string().optional() })),
})
export type SentAlert = z.infer<typeof SentAlert>
