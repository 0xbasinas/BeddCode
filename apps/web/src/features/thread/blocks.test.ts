import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from '@beddcode/client-runtime'
import { buildBlocks, totalChanges } from './blocks.ts'

const user = (id: string): TranscriptItem => ({ kind: 'message', id, role: 'user', text: id })
const text = (id: string): TranscriptItem => ({ kind: 'message', id, role: 'assistant', text: id })
const diff = (id: string, path: string, added: number, removed: number): TranscriptItem => ({
  kind: 'diff',
  id,
  path,
  added,
  removed,
  patch: `+${id}`,
})

describe('buildBlocks', () => {
  it('passes other items through untouched', () => {
    const items = [user('u1'), text('a1')]
    expect(buildBlocks(items)).toEqual([
      { kind: 'item', item: items[0] },
      { kind: 'item', item: items[1] },
    ])
  })

  it("collects a turn's diffs into one block at the position of the last one", () => {
    const blocks = buildBlocks([
      user('u1'),
      diff('d1', 'a.ts', 2, 1),
      text('between'),
      diff('d2', 'b.ts', 5, 0),
      text('final'),
    ])
    expect(blocks.map((b) => (b.kind === 'item' ? b.item.id : b.kind))).toEqual([
      'u1',
      'between',
      'edits',
      'final',
    ])
    const edits = blocks[2]
    expect(edits?.kind === 'edits' && edits.files.map((f) => f.path)).toEqual(['a.ts', 'b.ts'])
  })

  it('merges repeated edits to one file, treating path spellings as the same file', () => {
    const [, edits] = buildBlocks([
      user('u1'),
      diff('d1', 'C:/w/a.ts', 1, 1),
      diff('d2', 'C:\\w\\a.ts', 3, 0),
    ])
    expect(edits?.kind).toBe('edits')
    if (edits?.kind !== 'edits') return
    expect(edits.files).toHaveLength(1)
    expect(edits.files[0]).toMatchObject({ added: 4, removed: 1, patch: '+d1\n+d2' })
    expect(totalChanges(edits.files)).toEqual({ added: 4, removed: 1 })
  })

  it("keeps each turn's edits separate", () => {
    const blocks = buildBlocks([
      user('u1'),
      diff('d1', 'a.ts', 1, 0),
      user('u2'),
      diff('d2', 'a.ts', 2, 0),
    ])
    const edits = blocks.filter((b) => b.kind === 'edits')
    expect(edits).toHaveLength(2)
    expect(edits.map((b) => b.kind === 'edits' && b.files[0]?.added)).toEqual([1, 2])
  })
})
