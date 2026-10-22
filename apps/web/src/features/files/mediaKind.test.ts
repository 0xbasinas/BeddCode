import { describe, expect, it } from 'vitest'
import { httpBase, mediaKindOf } from './mediaKind.ts'

describe('mediaKindOf', () => {
  it('picks a viewer from the extension, whatever the case', () => {
    expect(mediaKindOf('docs/shot.PNG')).toBe('image')
    expect(mediaKindOf('clip.webm')).toBe('video')
    expect(mediaKindOf('a/b/song.flac')).toBe('audio')
  })

  it('leaves text, svg and dotfiles to the editor', () => {
    expect(mediaKindOf('logo.svg')).toBeUndefined()
    expect(mediaKindOf('README.md')).toBeUndefined()
    expect(mediaKindOf('.png')).toBeUndefined()
    expect(mediaKindOf('png')).toBeUndefined()
  })
})

describe('httpBase', () => {
  it('turns a WebSocket address into the HTTP one', () => {
    expect(httpBase('ws://127.0.0.1:3773/ws')).toBe('http://127.0.0.1:3773')
    expect(httpBase('wss://build.example:8443/ws')).toBe('https://build.example:8443')
    expect(httpBase('ws://[fd7a::1]:3773/ws')).toBe('http://[fd7a::1]:3773')
  })

  it('refuses anything else', () => {
    expect(httpBase('http://x/ws')).toBeUndefined()
    expect(httpBase('nonsense')).toBeUndefined()
  })
})
