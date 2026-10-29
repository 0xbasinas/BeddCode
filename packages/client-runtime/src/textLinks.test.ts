import { describe, expect, it } from 'vitest'
import { findTextLinks, looksLikePath, pathFromHref, wholePath } from './textLinks.ts'

const paths = (text: string) =>
  findTextLinks(text)
    .filter((l) => l.kind === 'path')
    .map((l) => (l.kind === 'path' ? [l.path, l.line, l.column] : []))

describe('findTextLinks', () => {
  it('finds paths with a line and column', () => {
    expect(paths('See src/math.ts:2 and lib/a.ts:10:5.')).toEqual([
      ['src/math.ts', 2, undefined],
      ['lib/a.ts', 10, 5],
    ])
  })

  it('leaves a full stop or comma after a path out', () => {
    expect(paths('Edited README.md, then src/index.ts.')).toEqual([
      ['README.md', undefined, undefined],
      ['src/index.ts', undefined, undefined],
    ])
  })

  it('reads GitHub style line anchors', () => {
    expect(paths('look at src/a.ts#L12-L20')).toEqual([['src/a.ts', 12, undefined]])
    expect(paths('look at src/a.ts#L3C4')).toEqual([['src/a.ts', 3, 4]])
  })

  it('finds absolute, relative and home paths', () => {
    expect(paths('/repo/src/a.ts ./b.ts ../c/d.py ~/notes/x.md')).toEqual([
      ['/repo/src/a.ts', undefined, undefined],
      ['./b.ts', undefined, undefined],
      ['../c/d.py', undefined, undefined],
      ['~/notes/x.md', undefined, undefined],
    ])
  })

  it('finds Windows paths', () => {
    expect(paths('at C:\\repo\\src\\a.ts:7 and src\\b.ts')).toEqual([
      ['C:\\repo\\src\\a.ts', 7, undefined],
      ['src\\b.ts', undefined, undefined],
    ])
    expect(paths('D:/work/x.rs:1:2')).toEqual([['D:/work/x.rs', 1, 2]])
  })

  it('finds web addresses and keeps paths inside them out', () => {
    const links = findTextLinks('Docs: https://example.com/a/b.html (see https://x.dev/y).')
    expect(links.map((l) => [l.kind, l.text])).toEqual([
      ['url', 'https://example.com/a/b.html'],
      ['url', 'https://x.dev/y'],
    ])
  })

  it('keeps balanced brackets in an address', () => {
    const [link] = findTextLinks('https://en.wikipedia.org/wiki/Foo_(bar)')
    expect(link?.text).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })

  it('ignores prose, numbers and versions', () => {
    expect(paths('Version 1.2.3 and 42 things, e.g tests. Hello world.')).toEqual([])
  })

  it('does not start a path in the middle of a word', () => {
    expect(paths('foo@bar.com')).toEqual([])
  })

  it('reports where each link is', () => {
    const text = 'open src/a.ts:3 now'
    const [link] = findTextLinks(text)
    expect(text.slice(link!.start, link!.end)).toBe('src/a.ts:3')
  })
})

describe('looksLikePath', () => {
  it('needs a folder or an extension', () => {
    expect(looksLikePath('math.ts')).toBe(true)
    expect(looksLikePath('src/math')).toBe(true)
    expect(looksLikePath('math')).toBe(false)
    expect(looksLikePath('main.c')).toBe(true)
    expect(looksLikePath('/')).toBe(false)
  })
})

describe('wholePath', () => {
  it('accepts a code span that is only a path', () => {
    expect(wholePath('src/math.ts:2')).toMatchObject({ path: 'src/math.ts', line: 2 })
    expect(wholePath('npm run build')).toBeNull()
    expect(wholePath('cat src/a.ts')).toBeNull()
  })
})

describe('pathFromHref', () => {
  it('reads relative and file links', () => {
    expect(pathFromHref('src/a.ts#L4')).toEqual({ kind: 'path', path: 'src/a.ts', line: 4 })
    expect(pathFromHref('./a.ts:3:2')).toEqual({ kind: 'path', path: './a.ts', line: 3, column: 2 })
    expect(pathFromHref('file:///repo/a%20b.ts')).toEqual({ kind: 'path', path: '/repo/a b.ts' })
    expect(pathFromHref('file:///C:/repo/a.ts')).toEqual({ kind: 'path', path: 'C:/repo/a.ts' })
    expect(pathFromHref('C:\\repo\\a.ts')).toEqual({ kind: 'path', path: 'C:\\repo\\a.ts' })
  })

  it('leaves web links and anchors alone', () => {
    expect(pathFromHref('https://example.com/a.ts')).toBeNull()
    expect(pathFromHref('mailto:a@b.c')).toBeNull()
    expect(pathFromHref('#section')).toBeNull()
  })
})
