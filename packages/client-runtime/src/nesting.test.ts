import { describe, expect, it } from 'vitest'
import { nestSessions } from './nesting.ts'

const s = (id: string, parent?: string) => ({
  id,
  parent: parent ? { sessionId: parent } : undefined,
})

describe('nestSessions', () => {
  it('puts children under their parent, in order, and keeps orphans at the top', () => {
    const list = [s('c1', 'p'), s('x'), s('p'), s('g', 'c1'), s('c2', 'p'), s('o', 'gone')]
    expect(nestSessions(list).map((n) => `${n.session.id}:${n.depth}`)).toEqual([
      'x:0',
      'p:0',
      'c1:1',
      'g:2',
      'c2:1',
      'o:0',
    ])
  })

  it('never drops a session, even in a cycle', () => {
    expect(
      nestSessions([s('a', 'b'), s('b', 'a')])
        .map((n) => n.session.id)
        .sort(),
    ).toEqual(['a', 'b'])
  })
})
