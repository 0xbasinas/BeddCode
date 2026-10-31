import type { BaseWindow, Session, WebContents } from 'electron'

export interface ChromeExtensionOptions {
  session?: Session
  createTab?: (details: { url?: string; active?: boolean }) => Promise<[WebContents, BaseWindow]>
  createWindow?: (details: {
    url?: string | string[]
    width?: number
    height?: number
    focused?: boolean
  }) => Promise<BaseWindow>
  requestPermissions?: (
    extension: { name: string },
    permissions: { permissions?: string[]; origins?: string[] },
  ) => Promise<boolean>
}

export declare class ElectronChromeExtensions {
  constructor(options: ChromeExtensionOptions)
  static handleCRXProtocol(session: Session): void
  addTab(webContents: WebContents, window: BaseWindow): void
  removeTab(webContents: WebContents): void
  selectTab(webContents: WebContents): void
}
