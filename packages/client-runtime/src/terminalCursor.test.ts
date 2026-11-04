import { describe, expect, it } from 'vitest'
import { TerminalCursor } from './terminalCursor.ts'

describe('terminal cursor', () => {
  it('resumes, deduplicates overlapping output and detects gaps', () => {
    const cursor = new TerminalCursor()
    expect(cursor.attach('a')).toEqual({ t: 'term.attach', id: 'a' })
    expect(cursor.take({ data: 'hello', seq: 5, replay: true })).toEqual({
      data: 'hello',
      reset: true,
    })
    expect(cursor.attach('a')).toEqual({ t: 'term.attach', id: 'a', afterSeq: 5 })
    expect(cursor.take({ data: 'lo!', seq: 6 })).toEqual({ data: '!', reset: false })
    expect(cursor.take({ data: 'lo!', seq: 6 })).toEqual({ data: '', reset: false })
    expect(cursor.take({ data: 'x', seq: 8 })).toBe('gap')
    expect(cursor.attach('a')).toEqual({ t: 'term.attach', id: 'a', afterSeq: 6 })
    expect(cursor.take({ data: 'new', seq: 20, replay: true })).toEqual({
      data: 'new',
      reset: true,
    })
  })

  it('falls back to legacy replay and rejects invalid offsets', () => {
    const cursor = new TerminalCursor()
    cursor.take({ data: 'a', seq: 1 })
    expect(cursor.take({ data: 'history', replay: true })).toEqual({ data: 'history', reset: true })
    expect(cursor.attach('a')).toEqual({ t: 'term.attach', id: 'a' })
    expect(cursor.take({ data: 'ab', seq: 1 })).toBe('gap')
  })

  it('reports an incomplete replay and resumes from its end', () => {
    const cursor = new TerminalCursor()
    expect(cursor.take({ data: 'tail', seq: 104, replay: true, truncated: true })).toEqual({
      data: 'tail',
      reset: true,
      truncated: true,
    })
    expect(cursor.take({ data: 'tail!', seq: 105 })).toEqual({ data: '!', reset: false })
  })
})
