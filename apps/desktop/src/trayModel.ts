import type { DaemonState } from './daemon.ts'

/** Whether closing the window should hide it and keep the app (and its host) running. */
export function shouldHideOnClose(options: {
  keepRunning: boolean
  quitting: boolean
  platform: NodeJS.Platform
}): boolean {
  // macOS already keeps the app running after its last window closes.
  return options.keepRunning && !options.quitting && options.platform !== 'darwin'
}

/**
 * Hiding needs a tray icon to bring the app back, and Linux desktops differ in whether they show
 * one (GNOME does not without an extension), so there it is off until the user turns it on.
 */
export const defaultKeepRunning = (platform: NodeJS.Platform) => platform === 'win32'

/** Whether the app can be told to start when the user signs in (not possible on Linux). */
export const canStartAtLogin = (platform: NodeJS.Platform, packaged: boolean) =>
  packaged && (platform === 'win32' || platform === 'darwin')

export function statusLabel(state: DaemonState | null): string {
  switch (state?.status) {
    case 'running':
      return 'Host running'
    case 'attached':
      return 'Host running (started separately)'
    case 'starting':
    case 'restarting':
      return 'Host starting…'
    case 'failed':
      return 'Host could not start'
    default:
      return 'Host stopped'
  }
}

export interface TrayModel {
  status: DaemonState | null
  keepRunning: boolean
  startAtLogin: boolean
  canStartAtLogin: boolean
}

export interface TrayActions {
  open(): void
  toggleKeepRunning(): void
  toggleStartAtLogin(): void
  quit(): void
}

/** The parts of an Electron menu item the tray uses, so the menu can be built and tested without Electron. */
export interface MenuItem {
  label?: string
  type?: 'normal' | 'separator' | 'checkbox'
  checked?: boolean
  enabled?: boolean
  click?: () => void
}

export function trayMenu(model: TrayModel, actions: TrayActions): MenuItem[] {
  return [
    { label: 'Open BeddCode', click: actions.open },
    { type: 'separator' },
    { label: statusLabel(model.status), enabled: false },
    { type: 'separator' },
    {
      label: 'Keep running when the window is closed',
      type: 'checkbox',
      checked: model.keepRunning,
      click: actions.toggleKeepRunning,
    },
    ...(model.canStartAtLogin
      ? [
          {
            label: 'Start when I sign in',
            type: 'checkbox' as const,
            checked: model.startAtLogin,
            click: actions.toggleStartAtLogin,
          },
        ]
      : []),
    { type: 'separator' },
    { label: 'Quit BeddCode', click: actions.quit },
  ]
}
