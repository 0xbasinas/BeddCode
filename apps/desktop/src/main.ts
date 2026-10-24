import path from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { BrowserShared, BrowserViews } from './browserViews.ts'
import { parseBrowserCommand } from './browserCommand.ts'
import { Daemon, probeHealth, readLogTail, type DaemonState } from './daemon.ts'
import { autoUpdater } from 'electron-updater'
import { hostPort, serverLaunch } from './serverLaunch.ts'
import { shouldAutoUpdate, startAutoUpdate } from './updater.ts'
import { runWindowAction } from './windowActions.ts'

// Dev: the Vite server URL. Otherwise the app is loaded from the local host itself, which serves the
// built web app (so the page and the host share an origin and nothing has to be allowed).
const webUrl = process.env.BEDDCODE_WEB_URL
// Sent to the page whenever the window is maximized or restored (see preload.ts).
const WINDOW_MAXIMIZED = 'beddcode:window-maximized'
const DAEMON_STATUS = 'beddcode:daemon-status'

// Windows names a notification's sender by the app's user model id. Installed builds use the id the
// installer gave their Start menu shortcut (appId in electron-builder.yml), which shows the shortcut's
// name, BeddCode. From source there is no shortcut, so the id itself is what shows; make it the name.
if (process.platform === 'win32') {
  app.setAppUserModelId(app.isPackaged ? 'dev.beddcode.app' : 'BeddCode')
}

// The local host: started with the app, restarted if it stops, stopped with the app. Off when
// BEDDCODE_NO_DAEMON=1 (a host run by hand is found and used anyway; see daemon.ts).
let daemon: Daemon | null = null
function startDaemon() {
  if (process.env.BEDDCODE_NO_DAEMON === '1') return
  const port = hostPort(process.env)
  daemon = new Daemon({
    launch: serverLaunch({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
      serverDir: path.join(__dirname, '../../server'),
      env: process.env,
    }),
    probe: () => probeHealth(port),
    logFile: path.join(app.getPath('userData'), 'logs', 'host.log'),
  })
  daemon.onChange((state: DaemonState) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(DAEMON_STATUS, state)
  })
  daemon.start()
}

// The browser pane: one set of pages per window, sharing one session (see browserViews.ts).
const views = new Map<number, BrowserViews>()
let shared: BrowserShared | null = null
const browserShared = () => (shared ??= new BrowserShared())

function createWindow() {
  const win = new BrowserWindow({
    show: false,
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#101010',
    // macOS keeps its traffic lights, inset and centred on the header line. Elsewhere the window is
    // frameless and the app draws its own minimize / maximize / close (see WindowBar.tsx).
    ...(process.platform === 'darwin'
      ? { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 20 } }
      : { frame: false }),
    title: 'BeddCode',
    // The taskbar and window icon (installers carry the same images from build/).
    icon: path.join(__dirname, '../build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // The browser pane's pages are native views the main process owns (browserViews.ts).
      webviewTag: false,
    },
  })
  views.set(win.webContents.id, new BrowserViews(win, browserShared()))
  const contentsId = win.webContents.id
  win.on('closed', () => views.delete(contentsId))

  // Avoid showing the native window's empty background before the renderer's first paint.
  win.once('ready-to-show', () => {
    if (process.env.BEDDCODE_WINDOW_HIDDEN !== '1') win.show()
  })

  // The app's own window buttons follow the real state, however it changed (button, keyboard, WM).
  const sendMaximized = () => win.webContents.send(WINDOW_MAXIMIZED, win.isMaximized())
  win.on('maximize', sendMaximized)
  win.on('unmaximize', sendMaximized)

  if (webUrl) void win.loadURL(webUrl)
  else loadFromHost(win)
}

/** A plain page while the host starts, or when it will not. */
function splash(title: string, detail?: string): string {
  const esc = (text: string) => text.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`)
  const html = `<!doctype html><meta charset="utf-8"><title>BeddCode</title><body style="margin:0;height:100vh;display:grid;place-items:center;background:#101010;color:#ececec;font:14px system-ui,sans-serif;-webkit-app-region:drag"><div style="text-align:center;max-width:520px;padding:24px"><div style="font-size:18px;font-weight:600;margin-bottom:10px">${esc(title)}</div>${detail ? `<pre style="margin:0;color:#8a8a8a;white-space:pre-wrap;text-align:left;font-size:12px">${esc(detail)}</pre>` : ''}</div>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** Shows the app once the local host answers; until then a plain page says what is happening. */
function loadFromHost(win: BrowserWindow) {
  const appUrl = `http://127.0.0.1:${hostPort(process.env)}/`
  if (!daemon) return void win.loadURL(appUrl)
  void win.loadURL(splash('Starting BeddCode…'))
  let shown = false
  const check = (state: DaemonState) => {
    if (shown || win.isDestroyed()) return
    if (state.status === 'running' || state.status === 'attached') {
      shown = true
      off()
      void win.loadURL(appUrl)
    } else if (state.status === 'failed') {
      void win.loadURL(
        splash('BeddCode could not start its host. Trying again every minute.', state.detail),
      )
    }
  }
  const off = daemon.onChange(check)
  check(daemon.current)
  win.on('closed', off)
}

// The system's own folder picker, for adding a folder on this computer. Only the app's own page
// may open it (not pages shown in the browser pane), and it only ever returns a path the user chose.
ipcMain.handle('beddcode:pick-folder', async (event, options: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || event.sender !== win.webContents) return null
  const defaultPath =
    typeof options === 'object' &&
    options !== null &&
    typeof (options as { defaultPath?: unknown }).defaultPath === 'string'
      ? (options as { defaultPath: string }).defaultPath
      : undefined
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose a folder',
    buttonLabel: 'Select',
    defaultPath,
    properties: ['openDirectory', 'createDirectory'],
  })
  return result.canceled ? null : (result.filePaths[0] ?? null)
})

// Minimize, maximize/restore and close for the app's own window buttons. Like the folder picker,
// only the app's own page may ask (never a page shown in the browser pane).
ipcMain.handle('beddcode:window', (event, action: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || event.sender !== win.webContents) return null
  return runWindowAction(win, action)
})

// Only the app's own page may ask about the host or restart it (never a page in the browser pane).
ipcMain.handle('beddcode:daemon', async (event, action: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || event.sender !== win.webContents) return null
  switch (action) {
    case 'status':
      return daemon?.current ?? null
    case 'restart':
      return (await daemon?.restart()) ?? false
    case 'log':
      return daemon?.current.logFile ? readLogTail(daemon.current.logFile) : ''
    case 'reveal-log':
      if (daemon?.current.logFile) shell.showItemInFolder(daemon.current.logFile)
      return true
    default:
      return null
  }
})

// The browser pane's pages: show, navigate, find, capture… Only the app's own page may ask.
ipcMain.handle('beddcode:browser', (event, raw: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || event.sender !== win.webContents) return null
  const command = parseBrowserCommand(raw)
  const target = views.get(event.sender.id)
  return command && target ? target.handle(command) : null
})

// One app at a time: a second launch brings the first one forward instead of starting its own host.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })
}

let stopping = false
app.on('before-quit', (event) => {
  if (stopping || !daemon) return
  // Give the host a moment to shut down before the app goes.
  event.preventDefault()
  stopping = true
  void Promise.all([daemon.stop(), shared?.forwards.closeAll()]).finally(() => app.quit())
})

app.whenReady().then(() => {
  browserShared()
  startDaemon()
  createWindow()
  if (
    shouldAutoUpdate({ packaged: app.isPackaged, platform: process.platform, env: process.env })
  ) {
    startAutoUpdate(autoUpdater, (message) => console.warn(message))
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
