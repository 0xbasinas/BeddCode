import { describe, expect, it } from 'vitest'
import { environmentHint } from './environment.ts'

describe('environmentHint', () => {
  it('warns while the host is reconnecting, whatever the changes', () => {
    expect(environmentHint(false, { added: 0, removed: 0 })).toBe('warn')
    expect(environmentHint(false, { added: 3, removed: 1 })).toBe('warn')
  })

  it('marks uncommitted changes, and shows nothing for a clean, connected session', () => {
    expect(environmentHint(true, { added: 1, removed: 0 })).toBe('changes')
    expect(environmentHint(true, { added: 0, removed: 2 })).toBe('changes')
    expect(environmentHint(true, { added: 0, removed: 0 })).toBeUndefined()
  })
})
