import { describe, expect, it } from 'vitest'
import { appendReplyQuote } from './quote'

describe('appendReplyQuote', () => {
  it('quotes every line and keeps an existing draft', () => {
    expect(appendReplyQuote('Hello', 'one\ntwo', 3)).toBe(
      'Hello\n\nRegarding the agent\'s reply in turn 3:\n> one\n> two\n\n',
    )
  })
})
