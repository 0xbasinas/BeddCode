import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FileError, FileService } from './files.ts'
import { MediaTickets, mediaType, parseRange, serveMedia } from './media.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

function tmp() {
  const dir = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-media-')))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }))
  return dir
}

describe('mediaType', () => {
  it('knows images, video and audio by extension, whatever the case', () => {
    expect(mediaType('a/Shot.PNG')).toEqual({ kind: 'image', mime: 'image/png' })
    expect(mediaType('clip.mp4')?.kind).toBe('video')
    expect(mediaType('song.flac')?.kind).toBe('audio')
  })

  it('leaves everything else, svg included, to the editor', () => {
    expect(mediaType('logo.svg')).toBeUndefined()
    expect(mediaType('notes.txt')).toBeUndefined()
    expect(mediaType('Makefile')).toBeUndefined()
  })
})

describe('parseRange', () => {
  it('reads open, closed and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
  })

  it('clamps an end past the file and a suffix longer than it', () => {
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 })
  })

  it('refuses what cannot be satisfied or is not a single range', () => {
    const bad = ['bytes=1000-', 'bytes=5-2', 'bytes=-0', 'bytes=-', 'items=0-1', 'bytes=0-1,4-5']
    for (const header of bad) expect(parseRange(header, 1000)).toBeNull()
  })
})

describe('MediaTickets', () => {
  it('hands out unguessable tickets that expire', () => {
    let now = 1_000
    const tickets = new MediaTickets(() => now)
    const a = tickets.issue('/x/a.png', 'image/png')
    const b = tickets.issue('/x/a.png', 'image/png')
    expect(a).not.toBe(b)
    expect(a.length).toBeGreaterThanOrEqual(32)
    expect(tickets.lookup(a)?.file).toBe('/x/a.png')
    expect(tickets.lookup('nope')).toBeUndefined()
    now += 61 * 60_000
    expect(tickets.lookup(a)).toBeUndefined()
  })

  it('drops the oldest once there are too many', () => {
    const tickets = new MediaTickets()
    const first = tickets.issue('/x/0', 'image/png')
    for (let i = 1; i <= 200; i++) tickets.issue(`/x/${i}`, 'image/png')
    expect(tickets.lookup(first)).toBeUndefined()
  })
})

describe('FileService.mediaFor', () => {
  it('gives a ticket for a media file inside the folder, and null for other files', async () => {
    const dir = tmp()
    writeFileSync(path.join(dir, 'a.png'), Buffer.alloc(10))
    writeFileSync(path.join(dir, 'a.txt'), 'hi')
    const files = new FileService()
    const media = await files.mediaFor(dir, 'a.png')
    expect(media).toMatchObject({ kind: 'image', mime: 'image/png', size: 10 })
    expect(media?.url).toMatch(/^\/media\/[\w-]{32,}$/)
    const ticket = files.media.lookup(media!.url.slice('/media/'.length))
    expect(ticket?.file).toBe(path.join(dir, 'a.png'))
    expect(await files.mediaFor(dir, 'a.txt')).toBeNull()
  })

  it('refuses paths outside the folder and files that are not there', async () => {
    const dir = tmp()
    const files = new FileService()
    await expect(files.mediaFor(dir, '../x.png')).rejects.toThrow(FileError)
    await expect(files.mediaFor(dir, 'missing.png')).rejects.toThrow(/Not a file/)
  })
})

describe('serveMedia', () => {
  async function serve() {
    const dir = tmp()
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251))
    writeFileSync(path.join(dir, 'clip.mp4'), bytes)
    const files = new FileService()
    const server: Server = createServer((req, res) => {
      void serveMedia(files.media, (req.url ?? '').slice('/media/'.length), req, res)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())))
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const media = (await files.mediaFor(dir, 'clip.mp4'))!
    return { url: `${base}${media.url}`, base, bytes, dir }
  }

  it('streams the whole file with the right type and safety headers', async () => {
    const { url, bytes } = await serve()
    const res = await fetch(url)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('video/mp4')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes)
  })

  it('answers a range with 206 and just those bytes, so a video can seek', async () => {
    const { url, bytes } = await serve()
    const res = await fetch(url, { headers: { range: 'bytes=100-199' } })
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000')
    expect(res.headers.get('content-length')).toBe('100')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes.subarray(100, 200))
    const tail = await fetch(url, { headers: { range: 'bytes=-50' } })
    expect(Buffer.from(await tail.arrayBuffer())).toEqual(bytes.subarray(950))
  })

  it('refuses a range past the end', async () => {
    const { url } = await serve()
    const res = await fetch(url, { headers: { range: 'bytes=5000-' } })
    expect(res.status).toBe(416)
    expect(res.headers.get('content-range')).toBe('bytes */1000')
  })

  it('serves nothing without a valid ticket, and nothing once the file is gone', async () => {
    const { base, url, dir } = await serve()
    expect((await fetch(`${base}/media/not-a-ticket`)).status).toBe(404)
    expect((await fetch(`${base}/media/`)).status).toBe(404)
    rmSync(path.join(dir, 'clip.mp4'))
    expect((await fetch(url)).status).toBe(404)
  })

  it('answers HEAD with headers only', async () => {
    const { url } = await serve()
    const res = await fetch(url, { method: 'HEAD' })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('1000')
    expect((await res.arrayBuffer()).byteLength).toBe(0)
  })
})
