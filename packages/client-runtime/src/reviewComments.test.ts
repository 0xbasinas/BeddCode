import { describe, expect, it } from 'vitest'
import {
  commentAnchor,
  createReviewComment,
  formatReview,
  numberPatch,
  sortReviewComments,
  withoutSent,
} from './reviewComments.ts'

const PATCH = [
  'diff --git a/src/app.ts b/src/app.ts',
  'index 1111111..2222222 100644',
  '--- a/src/app.ts',
  '+++ b/src/app.ts',
  '@@ -1,6 +1,7 @@',
  ' import a from "a"',
  ' import b from "b"',
  '-const x = 1',
  '+const x = 2',
  '+const y = 3',
  ' ',
  ' export { a, b }',
  ' // end',
  '@@ -20,2 +21,2 @@ function tail() {',
  '-  return 1',
  '+  return 2',
  ' }',
  '',
].join('\n')

describe('numberPatch', () => {
  const lines = numberPatch(PATCH)

  it('numbers old and new lines across hunks', () => {
    const body = lines.filter((l) => l.kind !== 'meta' && l.kind !== 'hunk')
    expect(body.map((l) => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['context', 1, 1],
      ['context', 2, 2],
      ['del', 3, undefined],
      ['add', undefined, 3],
      ['add', undefined, 4],
      ['context', 4, 5],
      ['context', 5, 6],
      ['context', 6, 7],
      ['del', 20, undefined],
      ['add', undefined, 21],
      ['context', 21, 22],
    ])
    expect(lines.filter((l) => l.kind === 'meta')).toHaveLength(4)
    expect(lines.at(-1)!.text).toBe('}')
  })

  it('anchors removed lines on the old side and the rest on the new side', () => {
    expect(commentAnchor(lines.find((l) => l.kind === 'del')!)).toEqual({ side: 'old', line: 3 })
    expect(commentAnchor(lines.find((l) => l.kind === 'add')!)).toEqual({ side: 'new', line: 3 })
    expect(commentAnchor(lines.find((l) => l.kind === 'hunk')!)).toBeNull()
  })
})

describe('review comments', () => {
  const lines = numberPatch(PATCH)
  const at = (text: string) => lines.findIndex((l) => l.text === text)

  it('captures up to three lines of the same hunk on each side', () => {
    const c = createReviewComment({
      path: 'src/app.ts',
      lines,
      index: at('const y = 3'),
      body: ' Name this better ',
      id: 'c1',
      now: 1,
    })!
    expect(c).toMatchObject({ id: 'c1', side: 'new', line: 4, body: 'Name this better' })
    expect(c.context.hunk).toBe('@@ -1,6 +1,7 @@')
    expect(c.context.lines.map((l) => l.text)).toEqual([
      'import b from "b"',
      'const x = 1',
      'const x = 2',
      'const y = 3',
      '',
      'export { a, b }',
      '// end',
    ])
    expect(c.context.lines[c.context.target]!.text).toBe('const y = 3')

    const edge = createReviewComment({
      path: 'src/app.ts',
      lines,
      index: at('  return 2'),
      body: 'why?',
      id: 'c2',
    })!
    expect(edge.context.lines.map((l) => l.text)).toEqual(['  return 1', '  return 2', '}'])
  })

  it('refuses empty bodies and header lines', () => {
    expect(
      createReviewComment({ path: 'p', lines, index: at('const y = 3'), body: '  ' }),
    ).toBeNull()
    expect(createReviewComment({ path: 'p', lines, index: 4, body: 'x' })).toBeNull()
  })

  it('renders a message with the file, line, body and marked diff context', () => {
    const a = createReviewComment({
      path: 'src/b.ts',
      lines,
      index: at('const x = 1'),
      body: 'Keep 1',
      id: 'a',
      now: 2,
    })!
    const b = createReviewComment({
      path: 'src/app.ts',
      lines,
      index: at('const y = 3'),
      body: 'Rename y',
      id: 'b',
      now: 1,
    })!
    const text = formatReview({ cwd: '/repo', comments: [a, b] })
    expect(text).toContain('Review comments on the uncommitted changes in `/repo` (2).')
    expect(text.indexOf('`src/app.ts` line 4')).toBeLessThan(
      text.indexOf('`src/b.ts` line 3 (removed line)'),
    )
    expect(text).toContain('>        4 +const y = 3')
    expect(text).toContain('\n    3      -const x = 1')
    expect(text.match(/```diff/g)).toHaveLength(2)
  })

  it('sorts by file and line, and removes only what was sent', () => {
    const mk = (id: string, path: string, index: number) =>
      createReviewComment({ path, lines, index, body: id, id })!
    const all = [
      mk('3', 'b.ts', at('const y = 3')),
      mk('1', 'a.ts', at('const y = 3')),
      mk('2', 'a.ts', at('import a from "a"')),
    ]
    expect(sortReviewComments(all).map((c) => c.id)).toEqual(['2', '1', '3'])
    const late = mk('4', 'c.ts', at('// end'))
    expect(withoutSent([...all, late], all).map((c) => c.id)).toEqual(['4'])
  })
})
