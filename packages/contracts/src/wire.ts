import { z } from 'zod'
import { StoredEvent } from './events.ts'

export const PROTOCOL_VERSION = 1

/** Frames carried over the single host WebSocket (JSON text frames). */
export const ClientFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ping') }),
  z.object({ t: z.literal('hello'), protocol: z.number().int(), token: z.string().optional() }),
  z.object({
    t: z.literal('req'),
    id: z.string(),
    method: z.string(),
    params: z.unknown().optional(),
  }),
  /** Start receiving a terminal's output; the server replays what it has buffered first. */
  z.object({ t: z.literal('term.attach'), id: z.string() }),
  z.object({ t: z.literal('term.detach'), id: z.string() }),
  z.object({ t: z.literal('term.input'), id: z.string(), data: z.string() }),
  z.object({
    t: z.literal('term.resize'),
    id: z.string(),
    cols: z.number().int().min(2).max(500),
    rows: z.number().int().min(2).max(200),
  }),
  /** Get `fs.changed` frames for a folder while this connection is subscribed. */
  z.object({ t: z.literal('fs.watch'), cwd: z.string() }),
  z.object({ t: z.literal('fs.unwatch'), cwd: z.string() }),
  /** Subscribe to the event log, resuming after `afterSeq`. */
  z.object({ t: z.literal('subscribe'), afterSeq: z.number().int().nonnegative() }),
])
export type ClientFrame = z.infer<typeof ClientFrame>

export const HostInfo = z.object({
  hostId: z.string(),
  name: z.string(),
  platform: z.enum(['win32', 'linux', 'darwin']),
  version: z.string(),
  /** Legacy default folder for clients that omit cwd without requesting a projectless session. */
  defaultCwd: z.string().optional(),
})
export type HostInfo = z.infer<typeof HostInfo>

export const ServerFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('pong') }),
  z.object({ t: z.literal('welcome'), protocol: z.number().int(), host: HostInfo }),
  z.object({
    t: z.literal('res'),
    id: z.string(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().optional(),
  }),
  z.object({ t: z.literal('event'), stored: StoredEvent }),
  /** The host refused this connection (missing or wrong token). It closes right after. */
  z.object({ t: z.literal('denied'), reason: z.enum(['auth', 'origin', 'network']) }),
  /** Terminal output. `replay` marks the buffered history sent on attach. */
  z.object({
    t: z.literal('term.out'),
    id: z.string(),
    data: z.string(),
    replay: z.boolean().optional(),
  }),
  z.object({ t: z.literal('term.exit'), id: z.string(), code: z.number().int().nullable() }),
  /** Files changed under a watched folder (paths relative to it, forward slashes). */
  z.object({ t: z.literal('fs.changed'), cwd: z.string(), paths: z.array(z.string()) }),
  /** Sent once the requested replay is complete; later `event` frames are live. */
  z.object({ t: z.literal('caught-up'), seq: z.number().int().nonnegative() }),
])
export type ServerFrame = z.infer<typeof ServerFrame>
