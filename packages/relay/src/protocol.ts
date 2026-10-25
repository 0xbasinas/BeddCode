/**
 * What a BeddCode relay speaks. It is deliberately small: a relay forwards messages between a
 * host and the devices paired with it, and never needs to understand them. Everything inside `d`
 * is end-to-end encrypted by the endpoints (see client-runtime's relayCrypto.ts).
 *
 *   host    wss://relay/host/<room>     first frame {t:'host', auth}; then
 *           receives {t:'open'|'close'|'hi'|'m', c, ...} and sends {t:'hi'|'m'|'close', c, ...}
 *   device  wss://relay/client/<room>   sends {t:'hi', n} then {t:'m', d, f?}; receives the same
 *
 * `c` names one device connection to the host; devices never see it. `f` marks a piece of a large
 * message that is not the last. A relay answers the text `ping` with `pong`.
 */

/** Close codes a relay uses. Endpoints treat 4404 as "the host is not connected right now". */
export const CLOSE = {
  badRequest: 4400,
  unauthorized: 4401,
  hostOffline: 4404,
  roomFull: 4429,
  replaced: 4409,
} as const

export const MAX_CLIENTS_PER_ROOM = 8
/** One relay frame; endpoints split larger messages into pieces well under this. */
export const MAX_FRAME_CHARS = 128 * 1024
/** A host must claim its room within this long of connecting. */
export const CLAIM_TIMEOUT_MS = 10_000

export type ClientFrame = { t: 'hi'; n: string } | { t: 'm'; d: string; f?: boolean }
export type HostFrame =
  | { t: 'host'; auth: string }
  | { t: 'hi'; c: string; n: string }
  | { t: 'm'; c: string; d: string; f?: boolean }
  | { t: 'close'; c: string }

const ROOM = /^[A-Za-z0-9_-]{16,64}$/
const B64 = /^[A-Za-z0-9+/_-]*={0,2}$/
const CID = /^[0-9a-f]{8,32}$/

export const validRoom = (room: string | undefined): room is string => !!room && ROOM.test(room)

function parse(text: string): Record<string, unknown> | null {
  if (text.length > MAX_FRAME_CHARS) return null
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

const str = (v: unknown, max = MAX_FRAME_CHARS): v is string =>
  typeof v === 'string' && v.length <= max && B64.test(v)

export function parseClientFrame(text: string): ClientFrame | null {
  const f = parse(text)
  if (!f) return null
  if (f.t === 'hi' && str(f.n, 64)) return { t: 'hi', n: f.n }
  if (f.t === 'm' && str(f.d) && (f.f === undefined || typeof f.f === 'boolean'))
    return { t: 'm', d: f.d, f: f.f }
  return null
}

export function parseHostFrame(text: string): HostFrame | null {
  const f = parse(text)
  if (!f) return null
  if (f.t === 'host' && str(f.auth, 128)) return { t: 'host', auth: f.auth }
  if (typeof f.c !== 'string' || !CID.test(f.c)) return null
  if (f.t === 'close') return { t: 'close', c: f.c }
  if (f.t === 'hi' && str(f.n, 64)) return { t: 'hi', c: f.c, n: f.n }
  if (f.t === 'm' && str(f.d) && (f.f === undefined || typeof f.f === 'boolean'))
    return { t: 'm', c: f.c, d: f.d, f: f.f }
  return null
}

/** Compares two strings without stopping at the first difference. */
export function sameSecret(a: string, b: string): boolean {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/** May this connection act as a host? Always, unless the relay's owner set a password for hosts. */
export function hostAllowed(
  password: string | undefined,
  authorization: string | null | undefined,
) {
  if (!password) return true
  const given = /^Bearer (.+)$/.exec(authorization ?? '')?.[1] ?? ''
  return sameSecret(password, given)
}

export function newClientId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Where a request is aimed, from its path: `/host/<room>` or `/client/<room>`. */
export function route(pathname: string): { role: 'host' | 'client'; room: string } | null {
  const [, role, room, ...rest] = pathname.split('/')
  if (rest.length > 0 || (role !== 'host' && role !== 'client') || !validRoom(room)) return null
  return { role, room }
}
