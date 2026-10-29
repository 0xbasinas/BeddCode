import { describe, expect, it } from 'vitest'
import type { DesktopDaemonState } from '../../ui/desktop.ts'
import { HOST_LOST_AFTER_MS, hostNotice } from './hostStatus.ts'

const state = (status: DesktopDaemonState['status']): DesktopDaemonState => ({
  status,
  restarts: 0,
})

describe('hostNotice', () => {
  it('says nothing while connected, or once the app stopped connecting on purpose', () => {
    expect(hostNotice('connected', state('running'))).toBeNull()
    expect(hostNotice('connected', undefined)).toBeNull()
    expect(hostNotice('stopped', undefined)).toBeNull()
  })

  it('tells a browser (no desktop app to ask) that the link dropped, then that the host is gone', () => {
    expect(hostNotice('reconnecting', undefined)).toMatchObject({
      text: expect.stringMatching(/Reconnecting/),
      tone: 'info',
      retry: false,
    })
    expect(hostNotice('reconnecting', null, HOST_LOST_AFTER_MS)).toMatchObject({
      text: expect.stringMatching(/Cannot reach/),
      tone: 'error',
      retry: true,
    })
  })

  it('says when the app and the host speak different versions', () => {
    for (const daemon of [undefined, state('running')])
      expect(hostNotice('incompatible', daemon)).toMatchObject({
        text: expect.stringMatching(/different versions/),
        tone: 'error',
        retry: true,
      })
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

  it('says it is waiting for a host the app does not start itself', () => {
    expect(
      hostNotice('offline', { ...state('waiting'), detail: 'run beddcode serve' }),
    ).toMatchObject({
      text: expect.stringMatching(/Waiting/),
      detail: 'run beddcode serve',
      tone: 'info',
      retry: true,
    })
  })

  it('leaves a host the user refused to the pairing screen', () => {
    expect(hostNotice('denied', state('running'))).toBeNull()
  })
})
