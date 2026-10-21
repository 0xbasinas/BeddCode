import path from 'node:path'
import { app, BrowserWindow } from 'electron'

// Dev: the Vite server URL. Packaged: the built web app next to the desktop bundle.
const webUrl = process.env.BEDDCODE_WEB_URL

function createWindow() {
  const win = new BrowserWindow({
    show: process.env.BEDDCODE_WINDOW_HIDDEN !== '1',
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#111111',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#161616', symbolColor: '#9a9a9a', height: 44 },
    title: 'BeddCode',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The browser pane shows pages in <webview>; see will-attach-webview below.
      webviewTag: true,
    },
  })

  // Pages shown in the browser pane never get node access or a preload script of their own.
  win.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    // Only web pages may be shown; anything else (file:, javascript:) is refused.
    if (!/^https?:\/\//i.test(params.src ?? '')) _event.preventDefault()
  })

  if (webUrl) void win.loadURL(webUrl)
  else void win.loadFile(path.join(__dirname, '../../web/dist/index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
