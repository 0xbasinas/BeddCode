import { randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { MediaKind } from '@beddcode/contracts'

/**
 * Files the Files pane can show instead of editing. Only types a browser plays or shows natively;
 * SVG stays a text file so it can still be edited.
 */
const MEDIA: Record<string, { kind: MediaKind; mime: string }> = {
  '.png': { kind: 'image', mime: 'image/png' },
  '.jpg': { kind: 'image', mime: 'image/jpeg' },
  '.jpeg': { kind: 'image', mime: 'image/jpeg' },
  '.gif': { kind: 'image', mime: 'image/gif' },
  '.webp': { kind: 'image', mime: 'image/webp' },
  '.avif': { kind: 'image', mime: 'image/avif' },
  '.bmp': { kind: 'image', mime: 'image/bmp' },
  '.ico': { kind: 'image', mime: 'image/x-icon' },
  '.mp4': { kind: 'video', mime: 'video/mp4' },
  '.m4v': { kind: 'video', mime: 'video/mp4' },
  '.webm': { kind: 'video', mime: 'video/webm' },
  '.ogv': { kind: 'video', mime: 'video/ogg' },
  '.mov': { kind: 'video', mime: 'video/quicktime' },
  '.mp3': { kind: 'audio', mime: 'audio/mpeg' },
  '.wav': { kind: 'audio', mime: 'audio/wav' },
  '.ogg': { kind: 'audio', mime: 'audio/ogg' },
  '.oga': { kind: 'audio', mime: 'audio/ogg' },
  '.m4a': { kind: 'audio', mime: 'audio/mp4' },
  '.flac': { kind: 'audio', mime: 'audio/flac' },
}

export function mediaType(file: string): { kind: MediaKind; mime: string } | undefined {
  return MEDIA[path.extname(file).toLowerCase()]
}

const TICKET_TTL_MS = 60 * 60_000
const MAX_TICKETS = 200

interface Ticket {
  file: string
  mime: string
  expires: number
}

/**
 * Media elements (`<img>`, `<video>`) cannot send a token, so a viewer asks over its authenticated
 * connection for a ticket: an unguessable, short-lived address for exactly one file. The HTTP route
 * serves nothing without one.
 */
export class MediaTickets {
  private readonly tickets = new Map<string, Ticket>()

  constructor(private readonly now: () => number = Date.now) {}

  issue(file: string, mime: string): string {
    this.sweep()
    // Oldest first once there are too many; a viewer just asks again.
    while (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value
      if (oldest === undefined) break
      this.tickets.delete(oldest)
    }
    const token = randomBytes(24).toString('base64url')
    this.tickets.set(token, { file, mime, expires: this.now() + TICKET_TTL_MS })
    return token
  }

  lookup(token: string): Ticket | undefined {
    const ticket = this.tickets.get(token)
    if (!ticket) return undefined
    if (ticket.expires < this.now()) {
      this.tickets.delete(token)
      return undefined
    }
    return ticket
  }

  private sweep() {
    const now = this.now()
    for (const [token, t] of this.tickets) if (t.expires < now) this.tickets.delete(token)
  }
}

/** `bytes=a-b`, `bytes=a-` or `bytes=-n` against a file of `size` bytes; null when unsatisfiable. */
export function parseRange(header: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!match || (match[1] === '' && match[2] === '')) return null
  let start: number
  let end: number
  if (match[1] === '') {
    const suffix = Number(match[2])
    if (suffix === 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(match[1])
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1)
  }
  if (!Number.isFinite(start) || start >= size || start > end) return null
  return { start, end }
}

/** Streams the ticket's file, with range support so a video can seek. */
export async function serveMedia(
  tickets: MediaTickets,
  token: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const ticket = tickets.lookup(token)
  const info = ticket ? await stat(ticket.file).catch(() => null) : null
  if (!ticket || !info?.isFile()) {
    res.writeHead(404).end()
    return
  }
  const headers: Record<string, string | number> = {
    'content-type': ticket.mime,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    // Opened on its own it is just a file: nothing in it may run.
    'content-security-policy': "sandbox; default-src 'none'; media-src 'self'; img-src 'self'",
    // The page that shows it may be on another port or host.
    'cross-origin-resource-policy': 'cross-origin',
  }

  let status = 200
  let start = 0
  let end = info.size - 1
  const rangeHeader = req.headers.range
  if (rangeHeader) {
    const range = parseRange(rangeHeader, info.size)
    if (!range) {
      res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end()
      return
    }
    status = 206
    ;({ start, end } = range)
    headers['content-range'] = `bytes ${start}-${end}/${info.size}`
  }
  headers['content-length'] = info.size === 0 ? 0 : end - start + 1

  res.writeHead(status, headers)
  if (req.method === 'HEAD' || info.size === 0) {
    res.end()
    return
  }
  const stream = createReadStream(ticket.file, { start, end })
  stream.on('error', () => res.destroy())
  // A player that seeks or closes drops the connection; stop reading then.
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
