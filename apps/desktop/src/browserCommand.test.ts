import { describe, expect, it } from 'vitest'
import { parseBrowserCommand } from './browserCommand.ts'

describe('parseBrowserCommand', () => {
  it('accepts well-formed commands', () => {
    expect(parseBrowserCommand({ op: 'reload', tabId: 2 })).toEqual({ op: 'reload', tabId: 2 })
    expect(parseBrowserCommand({ op: 'ensure', tabId: 1, url: 'http://localhost:3000' })).toEqual({
      op: 'ensure',
      tabId: 1,
      url: 'http://localhost:3000',
    })
    expect(
      parseBrowserCommand({ op: 'layout', tabId: 1, bounds: { x: 1, y: 2, width: 3, height: 4 } }),
    ).toEqual({ op: 'layout', tabId: 1, bounds: { x: 1, y: 2, width: 3, height: 4 }, radius: 0 })
    expect(parseBrowserCommand({ op: 'layout', tabId: null, bounds: null, radius: 900 })).toEqual({
      op: 'layout',
      tabId: null,
      bounds: null,
      radius: 64,
    })
    expect(parseBrowserCommand({ op: 'find', tabId: 1, text: 'x' })).toEqual({
      op: 'find',
      tabId: 1,
      text: 'x',
      forward: true,
      next: false,
    })
    expect(
      parseBrowserCommand({ op: 'forward-port', route: 'ws://h:3773/ws', port: 5173 }),
    ).toEqual({
      op: 'forward-port',
      route: 'ws://h:3773/ws',
      token: undefined,
      port: 5173,
    })
    expect(parseBrowserCommand({ op: 'clear-data' })).toEqual({ op: 'clear-data' })
  })

  it('refuses anything else', () => {
    for (const bad of [
      null,
      'reload',
      { op: 'reload' },
      { op: 'reload', tabId: -1 },
      { op: 'reload', tabId: 1.5 },
      { op: 'unknown', tabId: 1 },
      { op: 'ensure', tabId: 1 },
      { op: 'layout', tabId: 1, bounds: { x: 'a', y: 0, width: 1, height: 1 } },
      { op: 'zoom', tabId: 1, direction: 2 },
      { op: 'forward-port', route: 'ws://h/ws', port: 0 },
      { op: 'open-external', url: 'file:///etc/passwd' },
      { op: 'permission', id: 'p1', allow: 'yes' },
      { op: 'capture', tabId: 1, rect: { x: 0 } },
    ])
      expect(parseBrowserCommand(bad)).toBeNull()
  })
})
