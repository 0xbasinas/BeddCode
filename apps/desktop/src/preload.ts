import { contextBridge } from 'electron'

// The renderer only learns it is inside the desktop shell; all data goes over the host WebSocket.
contextBridge.exposeInMainWorld('beddcodeDesktop', { platform: process.platform })
