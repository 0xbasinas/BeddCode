import { describe, expect, it } from 'vitest'
import { loopbackPort, remoteMachine, withPort } from './preview.ts'

describe('preview addresses', () => {
  it('finds the port of an address on this machine', () => {
    expect(loopbackPort('http://localhost:5173/app')).toBe(5173)
    expect(loopbackPort('http://127.0.0.1/')).toBe(80)
    expect(loopbackPort('https://localhost/')).toBe(443)
    expect(loopbackPort('http://[::1]:3000')).toBe(3000)
    expect(loopbackPort('http://0.0.0.0:8080')).toBe(8080)
    expect(loopbackPort('http://app.localhost:3000')).toBe(3000)
    expect(loopbackPort('https://example.com')).toBeNull()
    expect(loopbackPort('nonsense')).toBeNull()
  })

  it('moves an address to another local port', () => {
    expect(withPort('http://localhost:5173/a?b=1#c', 61000)).toBe('http://localhost:61000/a?b=1#c')
    expect(withPort('http://0.0.0.0:8080/', 8080)).toBe('http://localhost:8080/')
  })

  it('tells a remote host from one on this device', () => {
    expect(remoteMachine('ws://127.0.0.1:3773/ws')).toBeNull()
    expect(remoteMachine('ws://localhost:3773/ws')).toBeNull()
    expect(remoteMachine('ws://100.64.0.7:3773/ws')).toBe('100.64.0.7')
    expect(remoteMachine('wss://box.tail1234.ts.net/ws')).toBe('box.tail1234.ts.net')
    expect(remoteMachine(undefined)).toBeNull()
  })
})
