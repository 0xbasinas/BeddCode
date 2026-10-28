import { z } from 'zod'
import { BrowserUnavailable, BrowserUseCall, BrowserUseResult } from './browserUse.ts'
import { StoredEvent } from './events.ts'

export const PROTOCOL_VERSION = 1

/** Frames carried over the single host WebSocket (JSON text frames). */
export const ClientFrame = z.discriminatedUnion('t', [
  z.object({ t: z.literal('ping') }),
  /** Pair this device using a one-time code, over a connection that has no HTTP (a relay). */
  z.object({ t: z.literal('pair'), code: z.string().max(32), deviceName: z.string().max(80) }),
  z.object({
    t: z.literal('hello'),
    protocol: z.number().int(),
    token: z.string().optional(),
    /** This client can open compressed relay messages, so the host may send them. */
    z: z.boolean().optional(),
  }),
  z.object({
    t: z.literal('req'),
    id: z.string(),
    method: z.string(),
    params: z.unknown().optional(),
    /**
     * Names a request that may be sent again after a dropped connection. The host does the work
     * once and answers every repeat with the same result.
     */
    rid: z.string().max(64).optional(),
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
  z.object({
    t: z.literal('subscribe'),
    afterSeq: z.number().int().nonnegative(),
    /**
     * The client understands a compact replay: streamed text joined into one event and superseded
     * state left out. The state it builds is the same; far fewer frames cross the wire.
     */
    compact: z.boolean().optional(),
    /** The client understands `events` frames: the replay comes in groups, not one by one. */
    batch: z.boolean().optional(),
    /**
     * The log `afterSeq` belongs to. A client sends `subscribe` right behind `hello`, before it has
     * seen the host's `welcome`; a host with another log replays from the start instead.
     */
    logId: z.string().optional(),
  }),
  /**
   * Whether this client can run agents' browser tools (the desktop app can), and which session
   * it shows, so the host picks the right one. Sent again whenever either changes.
   */
  z.object({
    t: z.literal('browser.offer'),
    available: z.boolean(),
    reason: BrowserUnavailable.optional(),
    /** The session open in this client, and when the user last looked at it (epoch ms). */
    focus: z.object({ sessionId: z.string(), at: z.number() }).optional(),
  }),
  /** The answer to a `browser.call`. */
  z.object({ t: z.literal('browser.result'), id: z.string(), result: BrowserUseResult }),
  /**
   * Whether this client can draw designs to pictures for agents (the web and desktop apps can),
   * and what it has open in the Design screen: the design, its page and the selected elements.
   * Sent again whenever any of it changes.
   */
  z.object({
    t: z.literal('design.view'),
    canRender: z.boolean(),
    designId: z.string().optional(),
    pageId: z.string().optional(),
    selection: z.array(z.string()).max(200).optional(),
  }),
  /** The answer to a `design.layout`: every page with auto layout and text sizes worked out. */
  z.object({
    t: z.literal('design.laidout'),
    id: z.string(),
    pages: z.array(z.object({ id: z.string(), elements: z.array(z.unknown()) })).optional(),
    error: z.string().optional(),
  }),
  /** The answer to a `design.import`: the elements the SVG became, or why it did not. */
  z.object({
    t: z.literal('design.imported'),
    id: z.string(),
    elements: z.array(z.unknown()).max(500).optional(),
    error: z.string().optional(),
  }),
  /** The answer to a `design.render`: a picture, or why there is none. */
  z.object({
    t: z.literal('design.rendered'),
    id: z.string(),
    image: z.object({ data: z.string(), mime: z.string() }).optional(),
    error: z.string().optional(),
  }),
])
export type ClientFrame = z.infer<typeof ClientFrame>

export const HostInfo = z.object({
  hostId: z.string(),
  name: z.string(),
  platform: z.enum(['win32', 'linux', 'darwin']),
  version: z.string(),
  /** Legacy default folder for clients that omit cwd without requesting a projectless session. */
  defaultCwd: z.string().optional(),
  /**
   * Which event log this is. It changes if the host's database is replaced, so a device that
   * saved its copy of the history knows when that copy no longer belongs to the host.
   */
  logId: z.string().optional(),
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
  /** Several events at once (a replay, sent to a client that asked for `batch`), in seq order. */
  z.object({ t: z.literal('events'), events: z.array(StoredEvent) }),
  /** The host refused this connection (missing or wrong token). It closes right after. */
  z.object({ t: z.literal('denied'), reason: z.enum(['auth', 'origin', 'network']) }),
  /** The answer to `pair` when the code was right: this device's token, shown once. */
  z.object({ t: z.literal('paired'), token: z.string(), host: HostInfo }),
  /** The answer to `pair` when it was not (wrong, expired, or too many tries). */
  z.object({ t: z.literal('pair.failed'), error: z.string() }),
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
  /** An agent's browser tool call for this client to run (only sent to clients that offered). */
  /** A design canvas was saved or changed (by a client or an agent); fetch it with `design.get`. */
  z.object({
    t: z.literal('design.changed'),
    id: z.string(),
    rev: z.number().int(),
    origin: z.string().optional(),
    /** Ids of the elements an agent just added or changed. */
    touched: z.array(z.string()).max(500).optional(),
  }),
  /** An agent wants a picture of (part of) a design; only sent to clients that can render. */
  z.object({
    t: z.literal('design.render'),
    id: z.string(),
    designId: z.string(),
    pageId: z.string().optional(),
    elementId: z.string().optional(),
    scale: z.number().optional(),
  }),
  /** After an agent's edit: work out auto layout and text sizes of a design and send the pages back. */
  z.object({ t: z.literal('design.layout'), id: z.string(), designId: z.string() }),
  /** An agent wants SVG markup turned into editable elements; only sent to clients that can render. */
  z.object({
    t: z.literal('design.import'),
    id: z.string(),
    svg: z.string().max(200_000),
    width: z.number().optional(),
  }),
  z.object({ t: z.literal('browser.call'), id: z.string(), call: BrowserUseCall }),
])
export type ServerFrame = z.infer<typeof ServerFrame>
