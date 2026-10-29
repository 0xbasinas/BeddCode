import type { DesktopDaemonState } from '../../ui/desktop.ts'

export interface HostNotice {
  text: string
  /** The detail worth reading, such as the last thing the host said. */
  detail?: string
  tone: 'info' | 'error'
  /** Offer to start it again. */
  retry: boolean
}

/** After this long without the host, "reconnecting" turns into "cannot reach". */
export const HOST_LOST_AFTER_MS = 20_000

/**
 * What to tell the user about the local host, or nothing when it is fine. `connection` is the
 * app's link to it; `daemon` is what the desktop app knows about the process (absent in a browser
 * and for a host started some other way); `downForMs` is how long the link has been down.
 */
export function hostNotice(
  connection:
    'connecting' | 'connected' | 'reconnecting' | 'incompatible' | 'stopped' | 'denied' | string,
  daemon: DesktopDaemonState | null | undefined,
  downForMs = 0,
): HostNotice | null {
  if (connection === 'connected' || connection === 'denied' || connection === 'stopped') return null
  if (connection === 'incompatible') {
    return {
      text: 'This app and the BeddCode host are different versions.',
      detail:
        'Update the older one (and restart the host). The app checks again every minute, or now with Try again.',
      tone: 'error',
      retry: true,
    }
  }
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
    case 'stopped':
      return null
    default:
      // A browser, or a host the desktop app does not run: all we know is the connection.
      if (connection !== 'reconnecting' && connection !== 'connecting') return null
      if (downForMs >= HOST_LOST_AFTER_MS) {
        return {
          text: 'Cannot reach the BeddCode host. Still trying…',
          detail:
            'Check that the host and its computer are running and online. Agents on the host keep working meanwhile, and this device catches up when it reconnects.',
          tone: 'error',
          retry: true,
        }
      }
      return connection === 'connecting'
        ? { text: 'Connecting to the host…', tone: 'info', retry: false }
        : { text: 'Connection lost. Reconnecting…', tone: 'info', retry: false }
  }
}
