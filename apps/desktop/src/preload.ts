import { contextBridge, ipcRenderer } from 'electron'

// The renderer learns it is inside the desktop shell and may open the system folder picker; all
// other data goes over the host WebSocket.
contextBridge.exposeInMainWorld('beddcodeDesktop', {
  platform: process.platform,
  /** Opens the system's folder picker; resolves to the chosen folder, or null when cancelled. */
  pickFolder: (options?: { defaultPath?: string }): Promise<string | null> =>
    ipcRenderer.invoke('beddcode:pick-folder', options ?? {}),
})
