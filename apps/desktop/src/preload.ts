import { contextBridge, ipcRenderer } from 'electron'
import type { BrowserCommand, BrowserEvent } from '@beddcode/contracts'

// The renderer learns it is inside the desktop shell, may open the system folder picker and drives
// its own window buttons; all other data goes over the host WebSocket.
contextBridge.exposeInMainWorld('beddcodeDesktop', {
  platform: process.platform,
  /** Opens the system's folder picker; resolves to the chosen folder, or null when cancelled. */
  pickFolder: (options?: { defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke('beddcode:pick-folder', options ?? {}),
  setTheme: (theme: 'light' | 'dark'): Promise<boolean> =>
    ipcRenderer.invoke('beddcode:theme', theme),
  /** The local host the app keeps running (see daemon.ts). */
  daemon: {
    status: (): Promise<unknown> => ipcRenderer.invoke('beddcode:daemon', 'status'),
    restart: (): Promise<boolean> => ipcRenderer.invoke('beddcode:daemon', 'restart'),
    log: (): Promise<string> => ipcRenderer.invoke('beddcode:daemon', 'log'),
    revealLog: (): Promise<boolean> => ipcRenderer.invoke('beddcode:daemon', 'reveal-log'),
    /** Calls back whenever the host's state changes; returns an unsubscribe. */
    onStatus(callback: (state: unknown) => void): () => void {
      const listener = (_event: unknown, state: unknown) => callback(state)
      ipcRenderer.on('beddcode:daemon-status', listener)
      return () => ipcRenderer.removeListener('beddcode:daemon-status', listener)
    },
  },
  /** The browser pane's pages, native views the main process lays over the pane (browserViews.ts). */
  browser: {
    /** Runs a command on a page (or the pane's session); see BrowserCommand in contracts. */
    command: (command: BrowserCommand): Promise<unknown> =>
      ipcRenderer.invoke('beddcode:browser', command),
    /** Everything the pages report: state, prompts, downloads, shortcuts; returns an unsubscribe. */
    onEvent(callback: (event: BrowserEvent) => void): () => void {
      const listener = (_event: unknown, event: BrowserEvent) => callback(event)
      ipcRenderer.on('beddcode:browser-event', listener)
      return () => ipcRenderer.removeListener('beddcode:browser-event', listener)
    },
    /** Pages asking for a new window; each address should open in a new tab. */
    onOpen(callback: (url: string) => void): () => void {
      const listener = (_event: unknown, event: BrowserEvent) => {
        if (event.type === 'open' && typeof event.url === 'string') callback(event.url)
      }
      ipcRenderer.on('beddcode:browser-event', listener)
      return () => ipcRenderer.removeListener('beddcode:browser-event', listener)
    },
  },
  /** The app's own window buttons (Linux and Windows; macOS keeps its traffic lights). */
  window: {
    minimize: (): Promise<boolean> => ipcRenderer.invoke('beddcode:window', 'minimize'),
    toggleMaximize: (): Promise<boolean> => ipcRenderer.invoke('beddcode:window', 'toggleMaximize'),
    close: (): Promise<boolean> => ipcRenderer.invoke('beddcode:window', 'close'),
    isMaximized: (): Promise<boolean> => ipcRenderer.invoke('beddcode:window', 'isMaximized'),
    /** Calls back whenever the window is maximized or restored; returns an unsubscribe. */
    onMaximizedChange(callback: (maximized: boolean) => void): () => void {
      const listener = (_event: unknown, maximized: unknown) => callback(Boolean(maximized))
      ipcRenderer.on('beddcode:window-maximized', listener)
      return () => ipcRenderer.removeListener('beddcode:window-maximized', listener)
    },
  },
})
