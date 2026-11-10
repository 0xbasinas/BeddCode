import { describe, expect, it } from 'vitest'
import { JsonRpcError } from '@beddcode/shared'
import { isSessionNotFound } from './errors.ts'

describe('isSessionNotFound', () => {
  it('knows the not-found codes', () => {
    expect(isSessionNotFound(new JsonRpcError(-32001, 'x'))).toBe(true)
    expect(isSessionNotFound(new JsonRpcError(-32002, 'x'))).toBe(true)
    expect(isSessionNotFound(new JsonRpcError(-32603, 'Internal error'))).toBe(false)
  })

  it('reads the many ways agents word it', () => {
    for (const message of [
      'Session abc-123 not found',
      'Unknown session',
      'invalid session identifier',
      'RESOURCE_NOT_FOUND',
    ])
      expect(isSessionNotFound(new Error(message))).toBe(true)
    expect(isSessionNotFound(new Error('rate limited'))).toBe(false)
  })

  it('finds the hint nested in the error data', () => {
    expect(
      isSessionNotFound(
        new JsonRpcError(-32603, 'Internal error', { error: { reason: 'unknown session' } }),
      ),
    ).toBe(true)
    expect(isSessionNotFound(new JsonRpcError(-32603, 'Internal error', { details: 'boom' }))).toBe(
      false,
    )
  })
})
