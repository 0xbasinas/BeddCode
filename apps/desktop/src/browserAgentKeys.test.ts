import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { cap, evaluateSource, parseKey } from './browserAgentKeys.ts'

describe('parseKey', () => {
  it('reads named keys, letters and combinations', () => {
    expect(parseKey('Enter')).toEqual({
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      text: '\r',
      modifiers: 0,
    })
    expect(parseKey('Control+a')).toEqual({
      key: 'a',
      code: 'KeyA',
      keyCode: 65,
      text: undefined,
      modifiers: 2,
    })
    expect(parseKey('Shift+a')).toMatchObject({ key: 'A', text: 'A', modifiers: 8 })
    expect(parseKey('Meta+Shift+K')).toMatchObject({ code: 'KeyK', modifiers: 12 })
    expect(parseKey('7')).toMatchObject({ code: 'Digit7', keyCode: 55, text: '7' })
    expect(parseKey('Control++')).toMatchObject({ key: '+', modifiers: 2 })
    expect(parseKey('esc')).toMatchObject({ key: 'Escape' })
  })
  it('refuses what is not one key', () => {
    expect(parseKey('Hello')).toBeNull()
    expect(parseKey('Hyper+a')).toBeNull()
    expect(parseKey('Control+')).toBeNull()
  })
})

describe('evaluateSource', () => {
  // As the page would: in a fresh context.
  const run = (script: string) => runInNewContext(evaluateSource(script)) as Promise<string>
  it('runs expressions, statements and functions, answering JSON', async () => {
    expect(await run('1 + 2')).toBe('3')
    expect(await run('const a = [1]; return a')).toBe('[\n  1\n]')
    expect(await run('() => "hi"')).toBe('"hi"')
    expect(await run('undefined')).toBe('undefined')
    expect(await run('const o = {}; o.self = o; return o')).toBe('{\n  "self": "[circular]"\n}')
    expect(await run('10n')).toBe('"10"')
  })
})

describe('cap', () => {
  it('cuts long text and says so', () => {
    expect(cap('abc', 5)).toBe('abc')
    expect(cap('abcdef', 3)).toBe('abc\n… (cut at 3 characters)')
  })
})
