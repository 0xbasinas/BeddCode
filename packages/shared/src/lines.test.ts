import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { readLines } from './lines.ts'

const collect = (options: Parameters<typeof readLines>[2] = {}) => {
  const input = new PassThrough()
  const lines: string[] = []
  const oversize: number[] = []
  readLines(input, (l) => lines.push(l), { onOversize: (n) => oversize.push(n), ...options })
  const ended = new Promise((r) => input.on('end', r))
  return { input, lines, oversize, end: async () => (input.end(), await ended) }
}

describe('readLines', () => {
  it('splits lines across chunks, strips \\r, and keeps the last unterminated line', async () => {
    const r = collect()
    r.input.write('a\r\nb')
    r.input.write('c\n\nd')
    await r.end()
    expect(r.lines).toEqual(['a', 'bc', '', 'd'])
  })

  it('keeps a multi-byte character split across chunks whole, and survives invalid UTF-8', async () => {
    const r = collect()
    const text = Buffer.from('Γειά 👋\n')
    r.input.write(text.subarray(0, 3))
    r.input.write(text.subarray(3, 9))
    r.input.write(text.subarray(9))
    r.input.write(Buffer.from([0xff, 0xfe, 0x41, 0x0a]))
    await r.end()
    expect(r.lines[0]).toBe('Γειά 👋')
    expect(r.lines[1]).toBe('\ufffd\ufffdA')
  })

  it('drops a line longer than the cap, reports it once, and reads on', async () => {
    const r = collect({ maxBytes: 10 })
    r.input.write('ok\n')
    r.input.write('x'.repeat(8))
    r.input.write('x'.repeat(8))
    r.input.write('x'.repeat(8) + '\nafter\n')
    r.input.write('y'.repeat(20) + '\n')
    await r.end()
    expect(r.lines).toEqual(['ok', 'after'])
    expect(r.oversize).toEqual([24, 20])
  })

  it('keeps reading after a line handler throws', async () => {
    const input = new PassThrough()
    const seen: string[] = []
    const errors: unknown[] = []
    readLines(
      input,
      (l) => {
        if (l === 'bad') throw new Error('boom')
        seen.push(l)
      },
      { onError: (e) => errors.push(e) },
    )
    input.end('bad\ngood\n')
    await new Promise((r) => input.on('end', r))
    expect(seen).toEqual(['good'])
    expect(errors).toHaveLength(1)
  })
})
