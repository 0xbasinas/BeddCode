import { describe, expect, it } from 'vitest'
import {
  WARM_POOL_DEFAULTS,
  WarmPoolSettings,
  ClientFrame,
  FolderListing,
  RpcMethods,
  ServerFrame,
  SessionEvent,
} from './index.ts'

describe('contracts', () => {
  it('parses a session event', () => {
    const e = SessionEvent.parse({ type: 'turn.completed', sessionId: 's1', at: 1, reason: 'done' })
    expect(e.type).toBe('turn.completed')
  })

  it('rejects an unknown event type', () => {
    expect(() => SessionEvent.parse({ type: 'nope', sessionId: 's1', at: 1 })).toThrow()
  })

  it('parses wire frames', () => {
    expect(ClientFrame.parse({ t: 'hello', protocol: 1 }).t).toBe('hello')
    const f = ServerFrame.parse({
      t: 'welcome',
      protocol: 1,
      host: { hostId: 'h', name: 'This PC', platform: 'win32', version: '0.0.0' },
    })
    expect(f.t).toBe('welcome')
  })

  it('describes folder listings for the folder browser', () => {
    const listing = FolderListing.parse({
      path: '/home/g/code',
      parent: '/home/g',
      home: '/home/g',
      crumbs: [
        { name: '/', path: '/' },
        { name: 'g', path: '/home/g', home: true },
        { name: 'code', path: '/home/g/code' },
      ],
      entries: [
        { name: 'api', path: '/home/g/code/api', isRepo: true, branch: 'main', modifiedAt: 1 },
        { name: 'notes', path: '/home/g/code/notes', isRepo: false },
      ],
      truncated: false,
    })
    expect(listing.entries.map((e) => e.isRepo)).toEqual([true, false])
    expect(() => FolderListing.parse({ ...listing, parent: undefined })).toThrow()
  })

  it('validates folder browse and git init params', () => {
    const browse = RpcMethods['folders.browse'].params
    expect(browse.parse({})).toEqual({})
    expect(browse.parse({ path: '/srv', showHidden: true }).path).toBe('/srv')
    expect(() => browse.parse({ path: '' })).toThrow()
    expect(() => RpcMethods['projects.initGit'].params.parse({ path: '' })).toThrow()
  })

  it('validates warm pool settings and changes', () => {
    expect(WarmPoolSettings.parse(WARM_POOL_DEFAULTS)).toEqual(WARM_POOL_DEFAULTS)
    expect(WARM_POOL_DEFAULTS.enabled).toBe(false)
    const set = RpcMethods['host.warmPool.set'].params
    expect(set.parse({})).toEqual({})
    expect(set.parse({ size: 4 })).toEqual({ size: 4 })
    for (const bad of [
      { size: 5 },
      { size: -1 },
      { size: 1.2 },
      { enabled: 1 },
      { memoryCapMb: 0 },
    ])
      expect(() => set.parse(bad)).toThrow()
    expect(() => WarmPoolSettings.parse({ enabled: true, size: 1 })).toThrow()
    expect(RpcMethods['host.warmPool.get'].result).toBe(WarmPoolSettings)
  })
})
