import { expect, it } from 'vitest'
import { safeAdvertised } from './capabilityReport.ts'

it('retains capability structure without exposing strings or credential values', () => {
  expect(
    safeAdvertised({ steering: { supported: true }, token: 'secret', url: 'private', count: 3 }),
  ).toEqual({ steering: { supported: true }, token: '[redacted]', url: '[redacted]', count: 3 })
})

it('bounds nested and unusually large metadata', () => {
  expect((safeAdvertised(Array.from({ length: 100 }, () => true)) as unknown[]).length).toBe(30)
  expect(
    JSON.stringify(safeAdvertised({ a: { b: { c: { d: { e: { f: { g: true } } } } } } })),
  ).toContain('[truncated]')
})
