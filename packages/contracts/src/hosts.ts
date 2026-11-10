import { z } from 'zod'
import { HostInfo } from './wire.ts'

/** A one-time code the user types on another device to pair it with this host. */
export const PairingCode = z.object({
  code: z.string().regex(/^\d{6}$/),
  /** Epoch milliseconds after which the code no longer works. */
  expiresAt: z.number().int(),
  /** The same code with this host's addresses, as a link for a QR code (see pairLink.ts). */
  link: z.string().optional(),
})
export type PairingCode = z.infer<typeof PairingCode>

/** Whether this host is reachable through a relay, and the address it uses. */
export const RelaySettings = z.object({
  /** The relay's websocket address (wss://…), unset when no relay is used. */
  url: z.string().optional(),
  /** Whether this host presents a password to the relay (the password itself is never sent back). */
  passwordSet: z.boolean(),
  /** Whether anonymous speed measurements are uploaded to the relay (see telemetry.report). */
  telemetry: z.boolean(),
  status: z.enum(['off', 'connecting', 'online', 'offline']),
})
export type RelaySettings = z.infer<typeof RelaySettings>

/** Limits for the idle agent processes kept ready for new sessions. */
export const WARM_POOL_LIMITS = {
  size: { min: 0, max: 4 },
  memoryCapMb: { min: 64, max: 16384 },
  idleTimeoutMinutes: { min: 1, max: 1440 },
} as const
export const WARM_POOL_DEFAULTS = {
  enabled: false,
  size: 1,
  memoryCapMb: 1024,
  idleTimeoutMinutes: 10,
} as const

const warmField = (limit: { min: number; max: number }) =>
  z.number().int().min(limit.min).max(limit.max)

/** How many idle agent processes the host keeps ready, and how much memory they may use. */
export const WarmPoolSettings = z.object({
  /** Off by default: nothing is started ahead of time. */
  enabled: z.boolean(),
  /** Idle processes kept ready per agent and project (0 keeps none). */
  size: warmField(WARM_POOL_LIMITS.size),
  /** Total memory all idle processes may use together, in megabytes. */
  memoryCapMb: warmField(WARM_POOL_LIMITS.memoryCapMb),
  /** An idle process is closed after this many minutes. */
  idleTimeoutMinutes: warmField(WARM_POOL_LIMITS.idleTimeoutMinutes),
})
export type WarmPoolSettings = z.infer<typeof WarmPoolSettings>

/** A change: what is left out keeps its current value. */
export const WarmPoolChange = WarmPoolSettings.partial()
export type WarmPoolChange = z.infer<typeof WarmPoolChange>

export const McpGatewaySettings = z.object({
  url: z.string().optional(),
  secretSet: z.boolean(),
  status: z.enum(['off', 'connecting', 'online', 'offline']),
  error: z.string().optional(),
  allowApprovals: z.boolean().default(true),
  allowProjectRead: z.boolean().default(true),
})
export type McpGatewaySettings = z.infer<typeof McpGatewaySettings>

/**
 * One measurement: a number and a few short labels, never content. Names and labels are
 * restricted to a small alphabet on purpose, so nothing like a prompt or a path can be sent.
 */
export const MetricRecord = z.object({
  /** When it was taken, epoch ms. */
  t: z.number().int().nonnegative(),
  name: z.string().regex(/^[a-z0-9_.]{1,48}$/),
  value: z.number().finite(),
  tags: z
    .record(z.string().regex(/^[a-z0-9_]{1,24}$/), z.string().regex(/^[A-Za-z0-9_.:-]{0,40}$/))
    .refine((tags) => Object.keys(tags).length <= 6, 'at most 6 tags')
    .optional(),
})
export type MetricRecord = z.infer<typeof MetricRecord>

export const MetricPlatform = z.enum(['web', 'desktop', 'mobile'])
export type MetricPlatform = z.infer<typeof MetricPlatform>

/** A paired device: it can reach this host from outside the machine with its own token. */
export const Device = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number().int(),
  lastUsedAt: z.number().int().optional(),
})
export type Device = z.infer<typeof Device>

/** Answer of `POST /pair` when the code is right. The token is shown once and never stored in clear. */
export const PairResult = z.object({ token: z.string(), host: HostInfo })
export type PairResult = z.infer<typeof PairResult>

export const TailnetPeer = z.object({
  /** Short machine name, e.g. `build-server`. */
  name: z.string(),
  /** Full MagicDNS name without the trailing dot, e.g. `build-server.tailnet.ts.net`. */
  dnsName: z.string(),
  /** The peer's Tailscale IPv4 address. */
  ip: z.string(),
  online: z.boolean(),
  os: z.string(),
  /** Set when a BeddCode host answered on the probed port. */
  beddcode: z.object({ hostId: z.string(), name: z.string(), port: z.number().int() }).optional(),
})
export type TailnetPeer = z.infer<typeof TailnetPeer>

export const TailnetStatus = z.object({
  /** `running` means peers below are current; the others explain why the list is empty. */
  state: z.enum(['running', 'stopped', 'needs-login', 'not-installed', 'error']),
  message: z.string().optional(),
  /** This machine's own tailnet name and address, when running. */
  self: z.object({ name: z.string(), dnsName: z.string(), ip: z.string() }).optional(),
  peers: z.array(TailnetPeer),
})
export type TailnetStatus = z.infer<typeof TailnetStatus>

/** Host-wide provider preferences; absent values use the defaults. */
export const HostSettings = z.object({
  claudeBackend: z.enum(['sdk', 'cli']).default('sdk'),
})
export type HostSettings = z.infer<typeof HostSettings>

/** Session states a host reports in its stats, as the digests read them. */
export const SessionStatusStat = z.enum([
  'starting',
  'running',
  'needs-you',
  'idle',
  'error',
  'cancelled',
])
export type SessionStatusStat = z.infer<typeof SessionStatusStat>

/**
 * What the host counts about itself (`host.stats`, and `GET /metrics` in Prometheus format): how
 * many sessions and turns, what is waiting on the user, how much the data folder weighs, and how
 * long the host has been up. Counters only ever rise; gauges are read when asked.
 */
export const HostStats = z.object({
  host: HostInfo,
  /** Seconds since the host process started. */
  uptimeSeconds: z.number().int().nonnegative(),
  /** The last sequence number in the host's event log. */
  seq: z.number().int().nonnegative(),
  /** Counters since the host started, e.g. `turns_completed` with a `reason` label. */
  counters: z.record(z.string(), z.number().int().nonnegative()),
  sessions: z.object({
    total: z.number().int().nonnegative(),
    byStatus: z.record(SessionStatusStat, z.number().int().nonnegative()),
    activeTurns: z.number().int().nonnegative(),
    activeTools: z.number().int().nonnegative(),
    /** Approvals and questions waiting for an answer right now. */
    openRequests: z.number().int().nonnegative(),
    /** Messages queued behind the running turn. */
    queuedPrompts: z.number().int().nonnegative(),
    pinned: z.number().int().nonnegative(),
  }),
  storage: z.object({
    /** Size of the event-log database file. */
    dbBytes: z.number().int().nonnegative(),
    /** Size of all stored attachments. */
    attachmentsBytes: z.number().int().nonnegative(),
    /** Worktree folders under projects' `.wt/` whose session no longer exists. */
    staleWorktrees: z.array(z.string()),
  }),
  clients: z.object({
    websockets: z.number().int().nonnegative(),
  }),
})
export type HostStats = z.infer<typeof HostStats>

/** One session considered by `host.gc`. */
export const GcSessionReport = z.object({
  id: z.string(),
  title: z.string(),
  /** Epoch ms of the session's last activity. */
  lastActiveAt: z.number().int(),
  status: SessionStatusStat,
  worktree: z.string().optional(),
  pinned: z.boolean(),
  /** Whether it was (or, on a dry run, would be) deleted. */
  removed: z.boolean(),
  /** Why it was kept or could not be fully removed. */
  note: z.string().optional(),
})
export type GcSessionReport = z.infer<typeof GcSessionReport>

/** What `host.gc` did (or, with `dryRun`, would do): remove old sessions, worktrees and attachments. */
export const GcReport = z.object({
  dryRun: z.boolean(),
  /** Epoch ms before which a session's last activity makes it a candidate. */
  cutoff: z.number().int(),
  sessions: z.array(GcSessionReport),
  sessionsRemoved: z.number().int().nonnegative(),
  worktreesRemoved: z.number().int().nonnegative(),
  attachmentsRemoved: z.number().int().nonnegative(),
  attachmentBytesFreed: z.number().int().nonnegative(),
  dbBytesBefore: z.number().int().nonnegative(),
  dbBytesAfter: z.number().int().nonnegative(),
  vacuumed: z.boolean(),
})
export type GcReport = z.infer<typeof GcReport>
