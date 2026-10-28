import { describe, expect, it } from 'vitest'
import { insertMention, mentionAt } from './mentions.ts'

describe('mentionAt', () => {
  it('finds an @ at the start or after a space', () => {
    expect(mentionAt('@src/ap', 7)).toEqual({ start: 0, query: 'src/ap' })
    expect(mentionAt('look at @ap', 11)).toEqual({ start: 8, query: 'ap' })
    expect(mentionAt('look at @', 9)).toEqual({ start: 8, query: '' })
  })
  it('ignores an @ inside a word and a mention the caret has left', () => {
    expect(mentionAt('mail me@example', 15)).toBeUndefined()
    expect(mentionAt('@app is open', 12)).toBeUndefined()
    expect(mentionAt('no mention', 10)).toBeUndefined()
  })
  it('follows the caret inside the text', () => {
    expect(mentionAt('see @ap and more', 7)).toEqual({ start: 4, query: 'ap' })
  })
})

describe('insertMention', () => {
  it('puts the path in place of the typed part', () => {
    const m = mentionAt('look at @ap', 11)!
    expect(insertMention('look at @ap', 11, m, 'src/app.ts')).toEqual({
      text: 'look at @src/app.ts ',
      caret: 20,
    })
  })
  it('leaves a folder open for browsing into', () => {
    const m = mentionAt('see @sr', 7)!
    expect(insertMention('see @sr', 7, m, 'src', true)).toEqual({ text: 'see @src/', caret: 9 })
  })
  it('keeps the text after the caret and quotes paths with spaces', () => {
    const m = mentionAt('see @ap and more', 7)!
    expect(insertMention('see @ap and more', 7, m, 'my file.ts')).toEqual({
      text: 'see @"my file.ts" and more',
      caret: 18,
    })
  })
})
