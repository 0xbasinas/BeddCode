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
