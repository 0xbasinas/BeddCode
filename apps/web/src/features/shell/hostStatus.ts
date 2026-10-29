import type { DesktopDaemonState } from '../../ui/desktop.ts'

export interface HostNotice {
  text: string
  /** The detail worth reading, such as the last thing the host said. */
  detail?: string
  tone: 'info' | 'error'
  /** Offer to start it again. */
  retry: boolean
}

/**
 * What to tell the user about the local host, or nothing when it is fine. `connection` is the
 * app's link to it; `daemon` is what the desktop app knows about the process (absent in a browser).
 */
export function hostNotice(
  connection: 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'denied' | string,
  daemon: DesktopDaemonState | null | undefined,
): HostNotice | null {
  if (connection === 'connected' || connection === 'denied') return null
  switch (daemon?.status) {
    case 'starting':
      return { text: 'Starting the BeddCode host…', tone: 'info', retry: false }
    case 'restarting':
      return {
        text: 'The host stopped. Starting it again…',
        detail: daemon.detail,
        tone: 'info',
        retry: false,
      }
    case 'failed':
      return {
        text: 'The BeddCode host will not stay running.',
        detail: daemon.detail,
        tone: 'error',
        retry: true,
      }
    case 'waiting':
      // The app does not start a host itself here (its Host setting, or a background host).
      return {
        text: 'Waiting for the BeddCode host…',
        detail: daemon.detail,
        tone: 'info',
        retry: true,
      }
    case undefined:
    case 'stopped':
      return null
    default:
      return { text: 'Reconnecting to the host…', tone: 'info', retry: false }
  }
}
