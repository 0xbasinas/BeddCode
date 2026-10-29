import type { DaemonState } from './daemon.ts'
import type { HostMode } from './hostMode.ts'

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
    case 'waiting':
      return 'Waiting for the host…'
    default:
      return 'Host stopped'
  }
}

export interface TrayModel {
  status: DaemonState | null
  keepRunning: boolean
  startAtLogin: boolean
  canStartAtLogin: boolean
  hostMode: HostMode
  /** Whether the background host is installed; null where the app cannot set it up. */
  backgroundHost: boolean | null
}

export interface TrayActions {
  open(): void
  toggleKeepRunning(): void
  toggleStartAtLogin(): void
  setHostMode(mode: HostMode): void
  toggleBackgroundHost(): void
  quit(): void
}

/** The parts of an Electron menu item the tray uses, so the menu can be built and tested without Electron. */
export interface MenuItem {
  label?: string
  type?: 'normal' | 'separator' | 'checkbox' | 'radio' | 'submenu'
  checked?: boolean
  enabled?: boolean
  click?: () => void
  submenu?: MenuItem[]
}

const MODE_LABELS: Record<HostMode, string> = {
  auto: 'Automatic: the background host when installed, else its own',
  app: 'Let the app start its own',
  external: 'Only use a host started separately',
}

/** Where the host comes from, and the background host itself. */
function hostMenu(model: TrayModel, actions: TrayActions): MenuItem[] {
  return [
    ...(Object.keys(MODE_LABELS) as HostMode[]).map((mode) => ({
      label: MODE_LABELS[mode],
      type: 'radio' as const,
      checked: model.hostMode === mode,
      click: () => actions.setHostMode(mode),
    })),
    ...(model.backgroundHost === null
      ? []
      : [
          { type: 'separator' as const },
          {
            label: 'Run the host in the background, without the app',
            type: 'checkbox' as const,
            checked: model.backgroundHost,
            click: actions.toggleBackgroundHost,
          },
        ]),
  ]
}

export function trayMenu(model: TrayModel, actions: TrayActions): MenuItem[] {
  return [
    { label: 'Open BeddCode', click: actions.open },
    { type: 'separator' },
    { label: statusLabel(model.status), enabled: false },
    { label: 'Host', type: 'submenu', submenu: hostMenu(model, actions) },
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
