import { describe, expect, it } from 'vitest'
import {
  ConsoleLog,
  guardBrowserSession,
  isLoopbackUrl,
  navigationAllowed,
  nextZoom,
  pagesToDiscard,
  permissionKey,
  permissionVerdict,
  popupDisposition,
  popupTarget,
  safeFileName,
  shortcutFor,
  uniqueFileName,
  viewBounds,
  type GuardedSession,
  type KeyInput,
} from './browserGuard.ts'

describe('guardBrowserSession', () => {
  it('refuses permissions a preview does not need', () => {
    let onPermission: Parameters<GuardedSession['setPermissionRequestHandler']>[0] | undefined
    guardBrowserSession({
      setPermissionRequestHandler: (h) => (onPermission = h),
    })
    const granted = (p: string) => {
      let result: boolean | undefined
      onPermission!(null, p, (g) => (result = g))
      return result
    }
    expect(granted('notifications')).toBe(false)
    expect(granted('media')).toBe(false)
    expect(granted('fullscreen')).toBe(true)
  })
})

describe('permissions', () => {
  it('allows the harmless, asks for devices and location once, refuses the rest', () => {
    expect(permissionVerdict('fullscreen')).toBe('allow')
    expect(permissionVerdict('clipboard-sanitized-write')).toBe('allow')
    expect(permissionVerdict('media')).toBe('ask')
    expect(permissionVerdict('media', true)).toBe('allow')
    expect(permissionVerdict('geolocation', false)).toBe('deny')
    expect(permissionVerdict('notifications')).toBe('ask')
    expect(permissionVerdict('openExternal')).toBe('deny')
    expect(permissionVerdict('hid', true)).toBe('deny')
  })

  it('remembers per site, permission and device set', () => {
    expect(permissionKey('http://localhost:3000', 'media', ['video', 'audio'])).toBe(
      permissionKey('http://localhost:3000', 'media', ['audio', 'video']),
    )
    expect(permissionKey('http://localhost:3000', 'media', ['audio'])).not.toBe(
      permissionKey('http://localhost:3000', 'media', ['audio', 'video']),
    )
    expect(permissionKey('https://a.dev', 'geolocation')).toBe('https://a.dev|geolocation')
  })
})

describe('navigation', () => {
  it('passes web addresses and drops anything else', () => {
    expect(popupTarget('https://example.com/a')).toBe('https://example.com/a')
    expect(popupTarget('javascript:alert(1)')).toBeUndefined()
    expect(popupTarget('file:///etc/passwd')).toBeUndefined()
    expect(navigationAllowed('about:blank')).toBe(true)
    expect(navigationAllowed('http://localhost:5173/')).toBe(true)
    expect(navigationAllowed('file:///C:/Windows')).toBe(false)
    expect(navigationAllowed('chrome://gpu')).toBe(false)
  })

  it('gives links a tab and sign-in popups a window that keeps its opener', () => {
    expect(popupDisposition('https://x.dev', 'foreground-tab', '')).toBe('tab')
    expect(popupDisposition('https://x.dev', 'background-tab', '')).toBe('tab')
    expect(popupDisposition('https://accounts.x.dev', 'new-window', 'width=500,height=600')).toBe(
      'window',
    )
    expect(popupDisposition('https://x.dev', 'new-window', '')).toBe('tab')
    expect(popupDisposition('file:///x', 'new-window', 'width=1')).toBe('deny')
  })

  it('knows addresses on this machine', () => {
    for (const url of [
      'http://localhost:3000',
      'https://127.0.0.1:8443/x',
      'http://[::1]:5173',
      'http://app.localhost:3000',
    ])
      expect(isLoopbackUrl(url)).toBe(true)
    for (const url of ['https://example.com', 'http://10.0.0.2:3000', 'not a url'])
      expect(isLoopbackUrl(url)).toBe(false)
  })
})

describe('shortcutFor', () => {
  const key = (k: string, mods: Partial<KeyInput> = {}): KeyInput => ({
    type: 'keyDown',
    key: k,
    control: false,
    meta: false,
    alt: false,
    shift: false,
    ...mods,
  })
  it('maps the browser keys on each platform', () => {
    expect(shortcutFor(key('f', { control: true }), 'linux')).toBe('find')
    expect(shortcutFor(key('F', { control: true }), 'win32')).toBe('find')
    expect(shortcutFor(key('f', { meta: true }), 'darwin')).toBe('find')
    expect(shortcutFor(key('f', { control: true }), 'darwin')).toBeUndefined()
    expect(shortcutFor(key('r', { control: true, shift: true }), 'linux')).toBe('hard-reload')
    expect(shortcutFor(key('F5'), 'win32')).toBe('reload')
    expect(shortcutFor(key('ArrowLeft', { alt: true }), 'linux')).toBe('back')
    expect(shortcutFor(key('[', { meta: true }), 'darwin')).toBe('back')
    expect(shortcutFor(key('=', { control: true }), 'linux')).toBe('zoom-in')
    expect(shortcutFor(key('0', { control: true }), 'linux')).toBe('zoom-reset')
    expect(shortcutFor(key('I', { control: true, shift: true }), 'linux')).toBe('devtools')
    expect(shortcutFor(key('F12'), 'linux')).toBe('devtools')
    expect(shortcutFor(key('a'), 'linux')).toBeUndefined()
    expect(shortcutFor({ ...key('f', { control: true }), type: 'keyUp' }, 'linux')).toBeUndefined()
  })
})

describe('nextZoom', () => {
  it('steps through the zoom levels and stops at the ends', () => {
    expect(nextZoom(1, 1)).toBe(1.1)
    expect(nextZoom(1, -1)).toBe(0.9)
    expect(nextZoom(1.7, 0)).toBe(1)
    expect(nextZoom(3, 1)).toBe(3)
    expect(nextZoom(0.25, -1)).toBe(0.25)
  })
})

describe('viewBounds', () => {
  it('scales by the app page zoom and lands on whole pixels', () => {
    expect(viewBounds({ x: 10.4, y: 20.6, width: 300.2, height: 200 }, 1)).toEqual({
      x: 10,
      y: 21,
      width: 301,
      height: 200,
    })
    expect(viewBounds({ x: 10, y: 20, width: 300, height: 200 }, 1.25)).toEqual({
      x: 13,
      y: 25,
      width: 375,
      height: 250,
    })
    expect(viewBounds({ x: 0, y: 0, width: 0, height: 100 }, 1)).toBeNull()
    expect(viewBounds({ x: NaN, y: 0, width: 10, height: 10 }, 1)).toBeNull()
    expect(viewBounds(null, 1)).toBeNull()
  })
})

describe('download names', () => {
  it('keeps names inside the folder and valid on Windows', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('C:\\x\\report.pdf')).toBe('report.pdf')
    expect(safeFileName('a<b>:c?.txt')).toBe('a_b__c_.txt')
    expect(safeFileName('...')).toBe('download')
  })
  it('numbers a name that is taken', () => {
    const taken = new Set(['a.zip', 'a (1).zip', 'notes'])
    expect(uniqueFileName('a.zip', (n) => taken.has(n))).toBe('a (2).zip')
    expect(uniqueFileName('notes', (n) => taken.has(n))).toBe('notes (1)')
    expect(uniqueFileName('b.zip', (n) => taken.has(n))).toBe('b.zip')
  })
})

describe('ConsoleLog', () => {
  it('keeps the last messages and counts the errors among them', () => {
    const log = new ConsoleLog(3)
    const at = (level: 'error' | 'info', message: string) => log.push({ level, message, time: 0 })
    at('error', 'a')
    at('info', 'b')
    at('error', 'c')
    expect(log.errors).toBe(2)
    at('info', 'd')
    expect(log.list().map((e) => e.message)).toEqual(['b', 'c', 'd'])
    expect(log.errors).toBe(1)
    log.clear()
    expect(log.list()).toEqual([])
    expect(log.errors).toBe(0)
  })
})

describe('pagesToDiscard', () => {
  const page = (
    id: number,
    lastShown: number,
    extra: { visible?: boolean; busy?: boolean } = {},
  ) => ({
    id,
    lastShown,
    visible: false,
    busy: false,
    ...extra,
  })
  it('closes idle hidden pages, then the oldest past the limit, never the shown or busy one', () => {
    const now = 100_000
    const pages = [
      page(1, 0),
      page(2, 99_000),
      page(3, 98_000),
      page(4, 0, { busy: true }),
      page(5, 0, { visible: true }),
    ]
    expect(pagesToDiscard(pages, now, { idleMs: 50_000, maxLive: 10 })).toEqual([1])
    expect(pagesToDiscard(pages, now, { idleMs: 50_000, maxLive: 3 }).sort()).toEqual([1, 3])
  })
})
