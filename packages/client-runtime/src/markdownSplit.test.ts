import { describe, expect, it } from 'vitest'
import { splitStreamingMarkdown } from './markdownSplit.ts'

describe('splitStreamingMarkdown', () => {
  it('keeps finished paragraphs apart from the one being written', () => {
    expect(splitStreamingMarkdown('One.\n\nTwo.\n\nThree so far')).toEqual([
      'One.\n\nTwo.',
      'Three so far',
    ])
  })

  it('does not split a single paragraph, or text with nothing finished', () => {
    expect(splitStreamingMarkdown('just one paragraph')).toEqual(['', 'just one paragraph'])
    expect(splitStreamingMarkdown('')).toEqual(['', ''])
  })

  it('does not split inside an open code fence', () => {
    const text = 'Intro.\n\n```ts\nconst a = 1\n\nconst b = 2'
    expect(splitStreamingMarkdown(text)).toEqual(['Intro.', '```ts\nconst a = 1\n\nconst b = 2'])
  })

  it('splits after a closed fence', () => {
    const text = '```\ncode\n```\n\nafter'
    expect(splitStreamingMarkdown(text)).toEqual(['```\ncode\n```', 'after'])
  })

  it('does not break a list, table or quote that runs across a blank line', () => {
    expect(splitStreamingMarkdown('Intro.\n\n1. one\n\n2. tw')[0]).toBe('Intro.')
    expect(splitStreamingMarkdown('Intro.\n\n- a\n\n- b')[0]).toBe('Intro.')
    expect(splitStreamingMarkdown('Intro.\n\n| a | b |\n|---|---|\n\n| c | d |')[0]).toBe('Intro.')
    expect(splitStreamingMarkdown('Intro.\n\n> quote\n\n> more')[0]).toBe('Intro.')
  })

  it('always rejoins to the original text', () => {
    for (const text of ['a\n\nb\n\nc', 'x\n\n```\n\n```\n\ny', '- a\n\n- b\n\n', 'a\n\n\n\nb']) {
      const [head, tail] = splitStreamingMarkdown(text)
      expect(head ? `${head}\n\n${tail}` : tail).toBe(text)
    }
  })
})
