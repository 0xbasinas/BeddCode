import { describe, expect, it } from 'vitest'
import { guardBrowserSession, popupTarget, type GuardedSession } from './browserGuard.ts'

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

describe('popupTarget', () => {
  it('passes web addresses and drops anything else', () => {
    expect(popupTarget('https://example.com/a')).toBe('https://example.com/a')
    expect(popupTarget('javascript:alert(1)')).toBeUndefined()
    expect(popupTarget('file:///etc/passwd')).toBeUndefined()
  })
})
