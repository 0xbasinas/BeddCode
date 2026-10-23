import { describe, expect, it } from 'vitest'
import type { DesktopDaemonState } from '../../ui/desktop.ts'
import { hostNotice } from './hostStatus.ts'

const state = (status: DesktopDaemonState['status']): DesktopDaemonState => ({
  status,
  restarts: 0,
})

describe('hostNotice', () => {
  it('says nothing while connected, or in a browser with no desktop app to ask', () => {
    expect(hostNotice('connected', state('running'))).toBeNull()
    expect(hostNotice('offline', undefined)).toBeNull()
    expect(hostNotice('offline', null)).toBeNull()
  })

  it('says what the app is doing about a host that is not there', () => {
    expect(hostNotice('connecting', state('starting'))?.text).toMatch(/Starting/)
    expect(hostNotice('offline', { ...state('restarting'), detail: 'boom' })).toMatchObject({
      text: expect.stringMatching(/Starting it again/),
      detail: 'boom',
      retry: false,
    })
    expect(hostNotice('reconnecting', state('running'))?.text).toMatch(/Reconnecting/)
    expect(hostNotice('reconnecting', state('attached'))?.text).toMatch(/Reconnecting/)
  })

  it('offers a retry only when it has given up', () => {
    expect(hostNotice('offline', { ...state('failed'), detail: 'port in use' })).toMatchObject({
      tone: 'error',
      retry: true,
      detail: 'port in use',
    })
  })

  it('leaves a host the user refused to the pairing screen', () => {
    expect(hostNotice('denied', state('running'))).toBeNull()
  })
})
