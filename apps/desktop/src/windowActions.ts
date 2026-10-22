/** What the app's own window buttons may ask the main process to do. */
export const windowActions = ['minimize', 'toggleMaximize', 'close', 'isMaximized'] as const
export type WindowAction = (typeof windowActions)[number]

/** The part of a BrowserWindow the actions touch. */
export interface ControlledWindow {
  minimize(): void
  maximize(): void
  unmaximize(): void
  close(): void
  isMaximized(): boolean
}

/**
 * Runs one window action. Anything other than a known action is ignored. Resolves to whether the
 * window is maximized afterwards.
 */
export function runWindowAction(win: ControlledWindow, action: unknown): boolean | null {
  if (!windowActions.includes(action as WindowAction)) return null
  switch (action as WindowAction) {
    case 'minimize':
      win.minimize()
      break
    case 'toggleMaximize':
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
      break
    case 'close':
      win.close()
      break
    case 'isMaximized':
      break
  }
  return win.isMaximized()
}
