import { describe, expect, it } from 'vitest'
import { foldForSearch, rankCommands, scoreSubsequence, scoreWord } from './commandRanking.ts'

const ids = (items: { id: string }[]) => items.map((i) => i.id)

describe('foldForSearch', () => {
  it('drops case and accents, Greek included', () => {
    expect(foldForSearch('Café ΡΥΘΜΊΣΕΙΣ')).toBe('cafe ρυθμισεισ')
    expect(foldForSearch('Ρυθμίσεις')).toBe(foldForSearch('ρυθμισεις'))
    expect(foldForSearch('don’t')).toBe("don't")
  })
})

describe('scoreWord', () => {
  it('prefers exact, then prefix, then word start, then inside, then scattered letters', () => {
    const exact = scoreWord('git', 'git')!
    const prefix = scoreWord('git pane', 'git')!
    const boundary = scoreWord('toggle git pane', 'git')!
    const inside = scoreWord('digital', 'git')!
    const fuzzy = scoreWord('go into terminal', 'git')!
    expect([exact, prefix, boundary, inside, fuzzy]).toEqual(
      [exact, prefix, boundary, inside, fuzzy].sort((a, b) => a - b),
    )
    expect(scoreWord('terminal', 'xyz')).toBeNull()
  })

  it('scores tight subsequences better than loose ones', () => {
    expect(scoreSubsequence('new session', 'nse')!).toBeLessThan(
      scoreSubsequence('nothing to see', 'nse')!,
    )
    expect(scoreSubsequence('abc', 'abd')).toBeNull()
  })
})

describe('rankCommands', () => {
  const items = [
    { id: 'new', label: 'New session', keywords: ['chat', 'start'] },
    { id: 'settings', label: 'Open settings', keywords: ['preferences'] },
    { id: 'git', label: 'Show Git pane', keywords: ['changes', 'diff'] },
    { id: 'term', label: 'Show Terminal pane', keywords: ['shell'] },
    { id: 'sess', label: 'Fix login bug', keywords: ['session', 'beddcode'], bias: 20 },
  ]

  it('keeps the order for an empty query and respects the limit', () => {
    expect(ids(rankCommands(items, '  '))).toEqual(['new', 'settings', 'git', 'term', 'sess'])
    expect(rankCommands(items, '', 2)).toHaveLength(2)
  })

  it('needs every word to match, in any order', () => {
    expect(ids(rankCommands(items, 'pane git'))).toEqual(['git'])
    expect(ids(rankCommands(items, 'pane'))).toEqual(['git', 'term'])
  })

  it('finds by keywords, ranking label hits first', () => {
    expect(ids(rankCommands(items, 'diff'))).toEqual(['git'])
    expect(ids(rankCommands(items, 'chat'))).toEqual(['new'])
    expect(ids(rankCommands(items, 'session')).sort()).toEqual(['new', 'sess'])
    // The same word start in a label beats it in a keyword.
    expect(ids(rankCommands(items, 'sh'))[0]).toBe('git')
  })

  it('tolerates scattered letters', () => {
    expect(ids(rankCommands(items, 'opset'))).toEqual(['settings'])
  })
})
