import { describe, expect, it } from 'vitest'
import { MessageIds } from './messageIds.ts'

describe('MessageIds', () => {
  it('gives a message sent again after no answer the same id', () => {
    const ids = new MessageIds()
    const first = ids.begin('s1', 'hello', ['a'])
    const again = ids.begin('s1', 'hello', ['a'])
    expect(again.id).toBe(first.id)
    expect(ids.begin('s2', 'hello', ['a']).id).not.toBe(first.id)
    expect(ids.begin('s1', 'hello').id).not.toBe(first.id)
  })

  it('gives the same words a new id once the first send was answered', () => {
    const ids = new MessageIds()
    const first = ids.begin('s1', 'yes')
    first.done()
    expect(ids.begin('s1', 'yes').id).not.toBe(first.id)
  })

  it('forgets an unanswered send after a while', () => {
    let now = 0
    const ids = new MessageIds(1_000, () => now)
    const first = ids.begin('s1', 'hi')
    now = 5_000
    expect(ids.begin('s1', 'hi').id).not.toBe(first.id)
  })
})
