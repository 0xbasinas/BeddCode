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
  status: z.enum(['off', 'connecting', 'online', 'offline']),
})
export type RelaySettings = z.infer<typeof RelaySettings>

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
