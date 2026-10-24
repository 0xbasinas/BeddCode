import { describe, expect, it } from 'vitest'
import type { SlashCommand } from '@beddcode/contracts'
import { insertCommand, matchCommands } from './slash.ts'

const commands: SlashCommand[] = [
  { name: 'review' },
  { name: 'compact' },
  { name: 'code-review', kind: 'skill' },
  { name: 'pdf', kind: 'skill' },
]

describe('matchCommands', () => {
  it('offers everything for a bare slash, and prefix matches before looser ones', () => {
    expect(matchCommands('/', commands).map((c) => c.name)).toEqual([
      'review',
      'compact',
      'code-review',
      'pdf',
    ])
    expect(matchCommands('/re', commands).map((c) => c.name)).toEqual(['review', 'code-review'])
    expect(matchCommands('/PD', commands).map((c) => c.name)).toEqual(['pdf'])
  })

  it('stays out of the way once the command is chosen or the text is not a command', () => {
    expect(matchCommands('/review something', commands)).toEqual([])
    expect(matchCommands('/review ', commands)).toEqual([])
    expect(matchCommands('hello /review', commands)).toEqual([])
    expect(matchCommands('', commands)).toEqual([])
    expect(matchCommands('/zzz', commands)).toEqual([])
    expect(matchCommands('/', undefined)).toEqual([])
    expect(matchCommands('/', [])).toEqual([])
  })

  it('shows at most eight', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ name: `c${i}` }))
    expect(matchCommands('/c', many)).toHaveLength(8)
  })

  it('inserts the command followed by a space for its argument', () => {
    expect(insertCommand({ name: 'review' })).toBe('/review ')
  })
})
