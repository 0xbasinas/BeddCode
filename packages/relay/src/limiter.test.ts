import { describe, expect, it } from 'vitest'
import { Limiter } from './limiter.ts'

describe('Limiter', () => {
  it('locks a caller out after too many wrong passwords, and only that caller', () => {
    const l = new Limiter({ maxFailures: 3, windowMs: 60_000 })
    for (let i = 0; i < 3; i++) {
      expect(l.check('a', i)).toBe(0)
      l.fail('a', i)
    }
    expect(l.check('a', 10)).toBeGreaterThan(0)
    expect(l.check('b', 10)).toBe(0)
  })

  it('lets the caller back in once the window has passed', () => {
    const l = new Limiter({ maxFailures: 1, windowMs: 1000 })
    l.fail('a', 0)
    expect(l.check('a', 500)).toBeGreaterThan(0)
    expect(l.check('a', 1500)).toBe(0)
  })

  it('caps requests and forgives failures after a correct password', () => {
    const l = new Limiter({ maxRequests: 2, maxFailures: 2, windowMs: 1000 })
    expect(l.check('a', 0)).toBe(0)
    expect(l.check('a', 1)).toBe(0)
    expect(l.check('a', 2)).toBeGreaterThan(0)
    l.fail('b', 0)
    l.succeed('b', 1)
    l.fail('b', 2)
    expect(l.check('b', 3)).toBe(0)
  })

  it('does not remember more callers than its cap', () => {
    const l = new Limiter({ maxCallers: 2 })
    for (const c of ['a', 'b', 'c']) l.check(c)
    expect((l as unknown as { callers: Map<string, unknown> }).callers.size).toBe(2)
  })
})
