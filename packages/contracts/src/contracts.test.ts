import { describe, expect, it } from 'vitest'
import { ClientFrame, FolderListing, RpcMethods, ServerFrame, SessionEvent } from './index.ts'

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
})
