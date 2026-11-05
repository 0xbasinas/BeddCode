import { describe, expect, it } from 'vitest'
import { routeOf, validRoute, withRoute } from './lastRoute.ts'

describe('last route', () => {
  it('takes the route of the app page only', () => {
    expect(routeOf('http://127.0.0.1:3773/#/s/abc', 'http://127.0.0.1:3773')).toBe('#/s/abc')
    expect(routeOf('https://example.com/#/s/abc', 'http://127.0.0.1:3773')).toBeUndefined()
    expect(routeOf('data:text/html,hi', 'http://127.0.0.1:3773')).toBeUndefined()
    expect(routeOf('http://127.0.0.1:3773/', 'http://127.0.0.1:3773')).toBeUndefined()
  })
  it('rejects routes that are not plain app paths', () => {
    expect(validRoute('#javascript:alert(1)')).toBeUndefined()
    expect(validRoute('#/a b')).toBeUndefined()
    expect(validRoute(`#/${'x'.repeat(600)}`)).toBeUndefined()
  })
  it('reopens the route, but never over an explicit one', () => {
    expect(withRoute('http://localhost:5173', '#/s/abc')).toBe('http://localhost:5173/#/s/abc')
    expect(withRoute('http://localhost:5173/#/?compose=true', '#/s/abc')).toBe(
      'http://localhost:5173/#/?compose=true',
    )
    expect(withRoute('http://localhost:5173', undefined)).toBe('http://localhost:5173')
  })
})
