import { describe, expect, it } from 'vitest'
import { diffText } from './diff.ts'

describe('diffText', () => {
  it('shows only the changed middle with context', () => {
    const old = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n')
    const next = ['a', 'b', 'c', 'D', 'e', 'f', 'g'].join('\n')
    expect(diffText(old, next)).toEqual({
      patch: ' b\n c\n-d\n+D\n e\n f',
      added: 1,
      removed: 1,
    })
  })

  it('treats a new file as all additions', () => {
    expect(diffText(null, 'x\ny\n')).toEqual({ patch: '+x\n+y', added: 2, removed: 0 })
  })

  it('handles identical text and deletions', () => {
    expect(diffText('same\n', 'same\n')).toMatchObject({ added: 0, removed: 0 })
    expect(diffText('a\nb\n', 'a\n')).toMatchObject({ added: 0, removed: 1, patch: ' a\n-b' })
  })
})
