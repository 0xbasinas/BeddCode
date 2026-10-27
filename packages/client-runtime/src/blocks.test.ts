import { describe, expect, it } from 'vitest'
import type { TranscriptItem } from './replica.ts'
import { buildBlocks, createBlockBuilder, sessionChanges, totalChanges } from './blocks.ts'

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

it('incremental blocks match a full rebuild through streaming, older edits, truncation and reset', () => {
  const build = createBlockBuilder()
  let items: TranscriptItem[] = []
  for (let turn = 0; turn < 25; turn++) {
    items = [...items, user(`u${turn}`), diff(`d${turn}`, 'a.ts', 1, 0), text(`a${turn}`)]
    expect(build(items)).toEqual(buildBlocks(items))
    const before = build(items)
    items = [...items.slice(0, -1), { ...items.at(-1)!, text: 'streaming' } as TranscriptItem]
    const after = build(items)
    expect(after).toEqual(buildBlocks(items))
    if (turn > 0) expect(after[0]).toBe(before[0])
  }
  items = items.map((item, i) => (i === 2 ? text('older change') : item))
  expect(build(items)).toEqual(buildBlocks(items))
  items = items.slice(0, 4)
  expect(build(items)).toEqual(buildBlocks(items))
  expect(build([])).toEqual([])
  expect(build([text('intro'), user('u'), diff('d', 'a.ts', 1, 0)])).toEqual(
    buildBlocks([text('intro'), user('u'), diff('d', 'a.ts', 1, 0)]),
  )
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

describe('buildBlocks: denied requests', () => {
  const options = [
    { id: 'allow', label: 'Allow', kind: 'allow' as const },
    { id: 'deny', label: 'Deny', kind: 'deny' as const },
  ]
  const tool = (outcome: 'allow' | 'deny'): TranscriptItem => ({
    kind: 'tool',
    id: 't1',
    title: 'Execute `rm README.md`',
    toolKind: 'command',
    status: outcome === 'deny' ? 'failed' : 'ok',
    approval: { requestId: 'r1', requestedAt: 0, resolvedAt: 1, outcome },
  })
  const approval = (resolvedOptionId: string, toolId?: string): TranscriptItem => ({
    kind: 'approval',
    id: 'a1',
    requestId: 'r1',
    toolId,
    title: 'Run this command?',
    detail: 'rm README.md',
    options,
    resolvedOptionId,
  })

  it('drops the answered "Denied" line when the tool row already says it', () => {
    const items = [tool('deny'), approval('deny', 't1')]
    expect(buildBlocks(items)).toEqual([{ kind: 'item', item: items[0] }])
  })

  it('keeps it when the request names no tool, and keeps allowed answers', () => {
    expect(buildBlocks([tool('deny'), approval('deny')])).toHaveLength(2)
    expect(buildBlocks([tool('allow'), approval('allow', 't1')])).toHaveLength(2)
  })
})

describe('buildBlocks with recorded turn changes', () => {
  it('lets the host-recorded changes card stand in for that turn’s agent diffs', () => {
    const items = [
      { kind: 'message', id: '1', role: 'user', text: 'one' },
      { kind: 'diff', id: '2', path: 'a.ts', added: 1, removed: 0, patch: '+a' },
      {
        kind: 'changes',
        id: '3',
        before: 'b',
        after: 'c',
        files: [{ path: 'a.ts', status: 'M', added: 3, removed: 1 }],
      },
      { kind: 'message', id: '4', role: 'user', text: 'two' },
      { kind: 'diff', id: '5', path: 'b.ts', added: 2, removed: 2, patch: '+b' },
    ] as const
    const blocks = buildBlocks([...items] as never)
    expect(blocks.map((b) => (b.kind === 'edits' ? 'edits' : b.item.kind))).toEqual([
      'message',
      'changes',
      'message',
      'edits',
    ])
    expect(sessionChanges([...items] as never)).toEqual({ added: 5, removed: 3 })
  })
})
