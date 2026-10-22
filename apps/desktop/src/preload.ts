import { contextBridge, ipcRenderer } from 'electron'

// The renderer learns it is inside the desktop shell, may open the system folder picker and drives
// its own window buttons; all other data goes over the host WebSocket.
contextBridge.exposeInMainWorld('beddcodeDesktop', {
  platform: process.platform,
  /** Opens the system's folder picker; resolves to the chosen folder, or null when cancelled. */
  pickFolder: (options?: { defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke('beddcode:pick-folder', options ?? {}),
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
