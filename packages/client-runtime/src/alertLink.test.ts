import { describe, expect, it } from 'vitest'
import { sessionOfAlert } from './alertLink.ts'

describe('sessionOfAlert', () => {
  it('reads the session from an alert payload or its link', () => {
    expect(sessionOfAlert({ kind: 'turnDone', sessionId: 'abc-1' })).toBe('abc-1')
    expect(sessionOfAlert({ url: 'beddcode://session/xyz_2' })).toBe('xyz_2')
  })

  it('opens nothing for test alerts or odd payloads', () => {
    expect(sessionOfAlert({ kind: 'turnDone' })).toBeUndefined()
    expect(sessionOfAlert(null)).toBeUndefined()
    expect(sessionOfAlert({ sessionId: '../settings' })).toBeUndefined()
    expect(sessionOfAlert({ url: 'https://evil.example/session/x' })).toBeUndefined()
  })
})
