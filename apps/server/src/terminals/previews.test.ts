import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TerminalManager, type PtyProcess } from './manager.ts'
import { detectPreviewUrls, mergePreviews } from './previews.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

describe('detectPreviewUrls', () => {
  it('finds URLs and bare host:port, normalizing to localhost', () => {
    expect(detectPreviewUrls('  ➜  Local:   http://localhost:5173/\n')).toEqual([
      'http://localhost:5173',
    ])
    expect(detectPreviewUrls('VITE v5 ready in 300 ms\n ➜ Local: http://localhost:5173')).toEqual([
      'http://localhost:5173',
    ])
    expect(detectPreviewUrls('listening on 127.0.0.1:8080')).toEqual(['http://localhost:8080'])
    expect(detectPreviewUrls('Network: http://192.168.1.5:3000')).toEqual([]) // not loopback
    expect(detectPreviewUrls('ssh -p 22 user@host')).toEqual([]) // boring port
    expect(detectPreviewUrls('http://[::1]:4000/app')).toEqual(['http://localhost:4000/app'])
  })

  it('finds a URL split across two chunks via the tail', () => {
    const first = 'Local: http://local'
    const second = 'host:3000/ ready'
    expect(detectPreviewUrls(second, first)).toEqual(['http://localhost:3000'])
  })

  it('ignores non-local URLs and ordinary ports', () => {
    expect(detectPreviewUrls('see https://example.com/docs')).toEqual([])
    expect(detectPreviewUrls('port 8080 is taken by something else')).toEqual([])
  })
})

describe('mergePreviews', () => {
  it('keeps newest first, deduplicated and capped', () => {
    expect(mergePreviews(['http://localhost:3000'], ['http://localhost:5173'])).toEqual([
      'http://localhost:5173',
      'http://localhost:3000',
    ])
    expect(mergePreviews(['http://localhost:3000'], ['http://localhost:3000'])).toEqual([
      'http://localhost:3000',
    ])
  })
})

describe('TerminalManager previews', () => {
  function fakePty() {
    let onData: (d: string) => void = () => {}
    const pty: PtyProcess = {
      pid: 1,
      onData: (l) => (onData = l),
      onExit: () => {},
      write: () => {},
      resize: () => {},
      kill: () => {},
      pause: () => {},
      resume: () => {},
    }
    return { pty, emit: (d: string) => onData(d) }
  }

  it('detects a dev server URL in terminal output and exposes it via previews()', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'beddcode-prev-'))
    dirs.push(dir)
    let current: ReturnType<typeof fakePty> | undefined
    const m = new TerminalManager({
      pty: (_file, _args, _options) => {
        current = fakePty()
        return current.pty
      },
      shell: () => ({ file: 'node', args: [], name: 'node' }),
    })
    const changes: unknown[] = []
    m.onChange((c) => changes.push(c))
    const t = m.create({ cwd: dir })
    expect(t.previews).toBeUndefined()
    current!.emit('➜  Local:   http://localhost:5173/\n')
    const after = m.list(dir)[0]!
    expect(after.previews).toEqual(['http://localhost:5173'])
    expect(m.previews()).toEqual([{ url: 'http://localhost:5173', terminalId: t.id, cwd: dir }])
    // Same URL again: no duplicate, no change event.
    const before = changes.length
    current!.emit('➜  Local:   http://localhost:5173/\n')
    expect(m.list(dir)[0]!.previews).toEqual(['http://localhost:5173'])
    expect(changes.length).toBe(before)
    // A second server appears alongside.
    current!.emit('also on 0.0.0.0:8080\n')
    expect(m.list(dir)[0]!.previews).toEqual(['http://localhost:5173', 'http://localhost:8080'])
  })
})
