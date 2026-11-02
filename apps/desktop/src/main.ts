import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  Notification,
  session as electronSession,
  shell,
  Tray,
  type Session,
  type WebContents,
} from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { BrowserViews, browserSharedFor, closeBrowserForwards } from './browserViews.ts'
import { parseBrowserCommand } from './browserCommand.ts'
import { cliLaunch } from './cliLaunch.ts'
import { Daemon, probeHealth, readLogTail, type DaemonState } from './daemon.ts'
import {
  readDesktopSettings,
  writeDesktopSettings,
  type DesktopSettings,
} from './desktopSettings.ts'
import { autoUpdater } from 'electron-updater'
import {
  backgroundHostInstalled,
  backgroundHostPort,
  planHost,
  resolveHostMode,
  startBackgroundHost,
  waitingDetail,
  type HostMode,
} from './hostMode.ts'
import { hostPort, serverLaunch } from './serverLaunch.ts'
import { shouldAutoUpdate, startAutoUpdate } from './updater.ts'
import {
  canStartAtLogin,
  defaultKeepRunning,
  shouldHideOnClose,
  statusLabel,
  trayMenu,
} from './trayModel.ts'
import { runWindowAction } from './windowActions.ts'
import { browserUserDataRoot, installedBrowsers, openInBrowser } from './installedBrowsers.ts'
import type { BrowserProfile } from '@beddcode/contracts'
import type { BrowserExtension } from '@beddcode/contracts'
import {
  copyChromiumExtensionData,
  copyUnpackedExtension,
  extensionPagesAt,
  localizedExtensionName,
  installedFirefoxExtensions,
  installedExtensionsInProfile,
  type StoredBrowserExtension,
} from './browserExtensions.ts'

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

// The local host. Where it comes from depends on the Host setting (see hostMode.ts): the background
// host when one is installed, a host already running (a terminal, a service), or one the app starts
// itself, restarts if it stops, and stops with the app. BEDDCODE_HOST_MODE overrides the setting, and
// BEDDCODE_NO_DAEMON=1 means "only use a host started separately".
let daemon: Daemon | null = null
let hostMode: HostMode = 'auto'
/** Whether the background host is installed; null where the app cannot set it up itself. */
let backgroundHost: boolean | null = null
/** Everything that follows the host's state; kept across a change of mode, which replaces the daemon. */
const hostListeners = new Set<(state: DaemonState) => void>()
const onHost = (listener: (state: DaemonState) => void) => {
  hostListeners.add(listener)
  return () => void hostListeners.delete(listener)
}
// The app sets up the background host with its own command line, so only an installed build can.
const canManageBackgroundHost = () =>
  app.isPackaged && (process.platform === 'win32' || process.platform === 'linux')

async function startDaemon() {
  hostMode = resolveHostMode(settings.hostMode, process.env)
  const port = hostPort(process.env)
  const installed = await backgroundHostInstalled()
  backgroundHost = canManageBackgroundHost() ? installed : null
  // A background host on another port (say the app runs on a test port) is neither used nor waited for.
  const servicePort = installed ? backgroundHostPort(process.platform, os.homedir()) : null
  const plan = planHost(hostMode, installed && (servicePort === null || servicePort === port))
  const next = new Daemon({
    launch: serverLaunch({
      packaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      execPath: process.execPath,
      serverDir: path.join(__dirname, '../../server'),
      env: process.env,
    }),
    probe: () => probeHealth(port),
    logFile: path.join(app.getPath('userData'), 'logs', 'host.log'),
    spawn: plan.spawn,
    startService: plan.useService ? () => startBackgroundHost() : undefined,
    waitingDetail: waitingDetail(plan, port, process.platform),
  })
  daemon = next
  next.onChange((state: DaemonState) => {
    if (daemon !== next) return
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(DAEMON_STATUS, state)
    for (const listener of hostListeners) listener(state)
  })
  next.start()
}

/** Stops the current daemon (and a host it started), starts one for the current settings, and reloads. */
async function restartDaemon() {
  const old = daemon
  daemon = null
  await old?.stop()
  await startDaemon()
  updateTray()
  if (!webUrl) for (const win of BrowserWindow.getAllWindows()) loadFromHost(win)
}

async function setHostMode(mode: HostMode) {
  if (mode === hostMode && mode === settings.hostMode) return
  saveSettings({ ...settings, hostMode: mode })
  await restartDaemon()
}

/** Runs the app's own `beddcode` command and collects what it says. */
function runOwnCli(args: string[]): Promise<{ ok: boolean; output: string }> {
  const launch = cliLaunch({
    argv: [process.execPath, ...args],
    packaged: app.isPackaged,
    defaultApp: false,
    resourcesPath: process.resourcesPath,
    execPath: process.execPath,
  })
  if (!launch) return Promise.resolve({ ok: false, output: 'Only an installed build can do this.' })
  return new Promise((resolve) => {
    let output = ''
    const child = spawn(launch.command, launch.args, {
      env: { ...process.env, ...launch.env },
      windowsHide: true,
    })
    child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
    child.on('error', (err) => resolve({ ok: false, output: err.message }))
    child.on('close', (code) => resolve({ ok: code === 0, output: output.trim() }))
  })
}

/**
 * Installs or removes the background host (`beddcode host install|uninstall`). It keeps running
 * after the app quits and starts at sign-in; the app then uses it instead of starting its own.
 */
async function toggleBackgroundHost() {
  const install = !backgroundHost
  if (install) {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Run in the background', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      title: 'BeddCode',
      message: 'Run the BeddCode host in the background?',
      detail:
        'It starts when you sign in and keeps running after you quit the app, so your phone and other computers can reach this one (paired devices and your tailnet only). The app uses it instead of starting its own. Turn it off here or with `beddcode host uninstall`.',
    })
    if (response !== 0) return
  }
  // The port has to be free for the background host, so stop a host the app started first.
  const old = daemon
  daemon = null
  await old?.stop()
  const port = hostPort(process.env)
  const portArgs = port === 3773 ? [] : ['--port', String(port)]
  const result = await runOwnCli(['host', install ? 'install' : 'uninstall', ...portArgs])
  if (!result.ok) {
    dialog.showErrorBox(
      'BeddCode',
      `Could not ${install ? 'set up' : 'remove'} the background host.\n\n${result.output}`,
    )
  } else if (install && settings.hostMode === 'app') {
    // "Start its own" would fight the background host for the port.
    saveSettings({ ...settings, hostMode: 'auto' })
  }
  await startDaemon()
  updateTray()
  if (!webUrl) for (const win of BrowserWindow.getAllWindows()) loadFromHost(win)
}

// The tray icon keeps the app, and the host it supervises, running after the window is closed.
const settingsFile = () => path.join(app.getPath('userData'), 'desktop-settings.json')
let settings: DesktopSettings = {}
const keepRunning = () => settings.keepRunning ?? defaultKeepRunning(process.platform)
const saveSettings = (next: DesktopSettings) => {
  settings = next
  writeDesktopSettings(settingsFile(), settings)
}
let quitting = false
let tray: Tray | null = null
// Started by the sign-in item (see the tray menu): stay in the tray until the user opens the app.
let startHidden = process.argv.includes('--hidden')

function showWindow() {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return createWindow()
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function updateTray() {
  if (!tray) return
  const menu = Menu.buildFromTemplate(
    trayMenu(
      {
        status: daemon?.current ?? null,
        keepRunning: keepRunning(),
        startAtLogin: app.getLoginItemSettings().openAtLogin,
        canStartAtLogin: canStartAtLogin(process.platform, app.isPackaged),
        hostMode,
        backgroundHost,
      },
      {
        open: showWindow,
        toggleKeepRunning: () => {
          saveSettings({ ...settings, keepRunning: !keepRunning() })
          updateTray()
        },
        toggleStartAtLogin: () => {
          const openAtLogin = !app.getLoginItemSettings().openAtLogin
          app.setLoginItemSettings({ openAtLogin, args: openAtLogin ? ['--hidden'] : [] })
          updateTray()
        },
        setHostMode: (mode) => void setHostMode(mode),
        toggleBackgroundHost: () => void toggleBackgroundHost(),
        quit: () => app.quit(),
      },
    ),
  )
  tray.setContextMenu(menu)
  tray.setToolTip(`BeddCode: ${statusLabel(daemon?.current ?? null)}`)
}

function createTray() {
  const icon = nativeImage
    .createFromPath(
      path.join(__dirname, '../build', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    )
    .resize({ width: 16, height: 16 })
  tray = new Tray(icon)
  tray.on('click', showWindow)
  onHost(updateTray)
  updateTray()
}

/** Tells the user, once, where the app went when its window closed. */
function hintTray() {
  if (settings.trayHintShown || !Notification.isSupported()) return
  saveSettings({ ...settings, trayHintShown: true })
  new Notification({
    title: 'BeddCode is still running',
    body: 'It stays in the tray so your sessions and phone keep working. Right-click the icon to quit.',
  }).show()
}

// The browser pane: one set of pages per window, sharing one session (see browserViews.ts).
const views = new Map<number, BrowserViews>()
const browserShared = () => browserSharedFor('default')

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
    const hidden = startHidden && tray !== null && keepRunning()
    startHidden = false
    if (process.env.BEDDCODE_WINDOW_HIDDEN !== '1' && !hidden) win.show()
  })

  // Signing out or shutting down must not be held up by a window that hides instead of closing.
  win.on('session-end', () => {
    quitting = true
  })

  // Closing the window hides it when the app is meant to keep running; Quit in the tray ends it.
  win.on('close', (event) => {
    if (
      !tray ||
      !shouldHideOnClose({ keepRunning: keepRunning(), quitting, platform: process.platform })
    )
      return
    event.preventDefault()
    win.hide()
    hintTray()
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
const unwatchHost = new Map<number, () => void>()
function loadFromHost(win: BrowserWindow) {
  const appUrl = `http://127.0.0.1:${hostPort(process.env)}/`
  const id = win.webContents.id
  unwatchHost.get(id)?.()
  if (!daemon) return void win.loadURL(appUrl)
  void win.loadURL(splash('Starting BeddCode…'))
  let shown = false
  let lastSplash = ''
  const show = (title: string, detail?: string) => {
    const url = splash(title, detail)
    if (url === lastSplash) return
    lastSplash = url
    void win.loadURL(url)
  }
  const check = (state: DaemonState) => {
    if (shown || win.isDestroyed()) return
    if (state.status === 'running' || state.status === 'attached') {
      shown = true
      off()
      void win.loadURL(appUrl)
    } else if (state.status === 'failed') {
      show('BeddCode could not start its host. Trying again every minute.', state.detail)
    } else if (state.status === 'waiting') {
      show('Waiting for the BeddCode host…', state.detail)
    }
  }
  const stop = onHost(check)
  const off = () => {
    stop()
    unwatchHost.delete(id)
  }
  unwatchHost.set(id, off)
  check(daemon.current)
  win.once('closed', off)
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

// The count of sessions waiting for the user, shown on the app's icon: a badge on macOS and Linux,
// an overlay on the Windows taskbar button (the page draws it, since the main process has no canvas).
ipcMain.handle('beddcode:attention', (event, rawCount: unknown, overlay: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || event.sender !== win.webContents) return false
  const count =
    typeof rawCount === 'number' && rawCount > 0 ? Math.min(Math.floor(rawCount), 99) : 0
  if (process.platform === 'win32') {
    const image =
      count > 0 && typeof overlay === 'string' && overlay.startsWith('data:image/png;base64,')
        ? nativeImage.createFromDataURL(overlay)
        : null
    win.setOverlayIcon(
      image && !image.isEmpty() ? image : null,
      count > 0 ? `${count} waiting for you` : '',
    )
  } else {
    app.setBadgeCount(count)
  }
  return true
})

// The page's theme sets the colour shown behind it (while resizing, and before it paints).
ipcMain.handle('beddcode:theme', (event, theme: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || event.sender !== win.webContents) return false
  win.setBackgroundColor(theme === 'light' ? '#e6e6e9' : '#101010')
  return true
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

const profileProjectKey = (projectPath: string) =>
  createHash('sha256')
    .update(path.resolve(projectPath || app.getPath('home')))
    .digest('hex')

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }
    return entities[character]!
  })

async function resolveChromiumProfileFolder(selectedPath: string): Promise<string> {
  const selected = path.resolve(selectedPath)
  const canReadPreferences = async (folder: string) => {
    try {
      await readFile(path.join(folder, 'Preferences'))
      return true
    } catch {
      return false
    }
  }
  if (await canReadPreferences(selected)) return selected
  try {
    const localState = JSON.parse(await readFile(path.join(selected, 'Local State'), 'utf8')) as {
      profile?: { last_used?: string; info_cache?: Record<string, unknown> }
    }
    const profileInfo = localState.profile?.info_cache ?? {}
    const candidates = [
      localState.profile?.last_used,
      ...Object.entries(profileInfo)
        .sort(([, a], [, b]) => {
          const aName = typeof a === 'object' && a && 'name' in a ? String(a.name) : ''
          const bName = typeof b === 'object' && b && 'name' in b ? String(b.name) : ''
          return aName.localeCompare(bName)
        })
        .map(([folder]) => folder),
    ].filter((candidate): candidate is string => Boolean(candidate))
    for (const candidate of [...new Set(candidates)]) {
      const folder = path.join(selected, candidate)
      if (await canReadPreferences(folder)) return folder
    }
  } catch {
    // The user may have selected a profile directory other than the browser's user-data root.
  }
  throw new Error(
    'Could not find a browser profile here. Choose a profile folder such as Default or Profile 1.',
  )
}

interface BrowserProfileFolder {
  name: string
  path: string
}

async function chromiumProfilesInRoot(rootPath: string): Promise<BrowserProfileFolder[]> {
  const root = path.resolve(rootPath)
  const hasPreferences = async (folder: string) => {
    try {
      await readFile(path.join(folder, 'Preferences'))
      return true
    } catch {
      return false
    }
  }
  if (await hasPreferences(root)) return [{ name: path.basename(root) || 'Default', path: root }]
  const found = new Map<string, BrowserProfileFolder>()
  try {
    const localState = JSON.parse(await readFile(path.join(root, 'Local State'), 'utf8')) as {
      profile?: { last_used?: string; info_cache?: Record<string, { name?: unknown }> }
    }
    for (const [folderName, info] of Object.entries(localState.profile?.info_cache ?? {})) {
      const folderPath = path.resolve(root, folderName)
      if (!folderPath.startsWith(`${root}${path.sep}`) || !(await hasPreferences(folderPath)))
        continue
      const name = typeof info.name === 'string' ? info.name : folderName
      found.set(folderPath, { name: `${name} (${folderName})`, path: folderPath })
    }
    const lastUsed = localState.profile?.last_used
    if (lastUsed) {
      const folderPath = path.resolve(root, lastUsed)
      if (folderPath.startsWith(`${root}${path.sep}`) && (await hasPreferences(folderPath))) {
        const info = localState.profile?.info_cache?.[lastUsed]
        const name = typeof info?.name === 'string' ? info.name : lastUsed
        found.set(folderPath, { name: `${name} (${lastUsed})`, path: folderPath })
      }
    }
  } catch {
    // Some Chromium forks omit Local State; inspect profile folders below.
  }
  if (!found.size) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const folderPath = path.join(root, entry.name)
      if (await hasPreferences(folderPath))
        found.set(folderPath, { name: entry.name, path: folderPath })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function firefoxProfilesInRoot(rootPath: string): Promise<BrowserProfileFolder[]> {
  const root = path.resolve(rootPath)
  const registryPath = path.join(root, 'profiles.ini')
  const alternateRegistryPath = path.join(path.dirname(root), 'profiles.ini')
  let iniPath = registryPath
  let registry = await readFile(iniPath, 'utf8').catch(async () => {
    iniPath = alternateRegistryPath
    return readFile(iniPath, 'utf8').catch(() => '')
  })
  const profileRoot = path.dirname(iniPath)
  const sections = [...registry.matchAll(/^\[([^\]]+)\]([\s\S]*?)(?=^\[|$)/gm)]
  const found = new Map<string, BrowserProfileFolder>()
  for (const [, sectionName, body] of sections) {
    if (!/^Profile\d+$/i.test(sectionName ?? '')) continue
    const field = (name: string) => body?.match(new RegExp(`^${name}=(.*)$`, 'mi'))?.[1]?.trim()
    const relativePath = field('Path')
    if (!relativePath) continue
    const folderPath =
      field('IsRelative') === '1' ? path.resolve(profileRoot, relativePath) : relativePath
    if (
      !(await readFile(path.join(folderPath, 'extensions.json'))
        .then(() => true)
        .catch(() => false))
    )
      continue
    const name = field('Name') || path.basename(folderPath)
    found.set(folderPath, { name: `${name} (${path.basename(folderPath)})`, path: folderPath })
  }
  if (!found.size) {
    const profileDirectory =
      path.basename(root).toLowerCase() === 'profiles' ? root : path.join(root, 'Profiles')
    const entries = await readdir(profileDirectory, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const folderPath = path.join(profileDirectory, entry.name)
      if (
        await readFile(path.join(folderPath, 'extensions.json'))
          .then(() => true)
          .catch(() => false)
      )
        found.set(folderPath, { name: entry.name, path: folderPath })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

async function chooseBrowserProfile(
  win: BrowserWindow,
  browserId: string,
  browserName: string,
  profiles: BrowserProfileFolder[],
): Promise<BrowserProfileFolder | null> {
  if (profiles.length === 1) return profiles[0]!
  if (!profiles.length) return null
  const buttons = [...profiles.map((profile) => profile.name), 'Cancel']
  const choice = await dialog.showMessageBox(win, {
    type: 'question',
    title: `Choose a ${browserName} profile`,
    message: `Which ${browserName} profile should BeddCode import from?`,
    detail: 'Only the selected profile is read. Your browser profile is never modified.',
    buttons,
    defaultId: Math.max(
      0,
      profiles.findIndex((profile) => /default/i.test(profile.name)),
    ),
    cancelId: buttons.length - 1,
  })
  return choice.response >= 0 && choice.response < profiles.length
    ? profiles[choice.response]!
    : null
}

async function resolveFirefoxProfileFolder(selectedPath: string): Promise<string> {
  const selected = path.resolve(selectedPath)
  try {
    await readFile(path.join(selected, 'extensions.json'))
    return selected
  } catch {
    // The user may have picked Firefox's profile registry folder instead.
  }
  const registryPath = path.join(selected, 'profiles.ini')
  let registry: string
  try {
    registry = await readFile(registryPath, 'utf8')
  } catch {
    throw new Error('Choose a Firefox profile folder containing extensions.json.')
  }
  const sections = [...registry.matchAll(/^\[([^\]]+)\]([\s\S]*?)(?=^\[|$)/gm)]
  const profiles = sections.flatMap(([, sectionName, body]) => {
    if (!/^Profile\d+$/i.test(sectionName ?? '')) return []
    const field = (name: string) => body?.match(new RegExp(`^${name}=(.*)$`, 'mi'))?.[1]?.trim()
    const profilePath = field('Path')
    if (!profilePath) return []
    const folder = field('IsRelative') === '1' ? path.resolve(selected, profilePath) : profilePath
    return [{ folder, isDefault: field('Default') === '1', name: field('Name') ?? profilePath }]
  })
  const installDefault = sections
    .filter(([, sectionName]) => /^Install/i.test(sectionName ?? ''))
    .map(([, body]) => body?.match(/^Default=(.*)$/im)?.[1]?.trim())
    .find(Boolean)
  const preferred = installDefault ? path.resolve(selected, installDefault) : undefined
  for (const profile of profiles.sort((a, b) => {
    if (a.folder === preferred) return -1
    if (b.folder === preferred) return 1
    return Number(b.isDefault) - Number(a.isDefault) || a.name.localeCompare(b.name)
  })) {
    try {
      await readFile(path.join(profile.folder, 'extensions.json'))
      return profile.folder
    } catch {
      // Ignore profiles that have not been initialized yet.
    }
  }
  throw new Error('No Firefox profiles with installed add-ons were found in this folder.')
}

function profilesFor(projectPath: string) {
  const key = profileProjectKey(projectPath)
  let profiles = settings.browserProfiles?.[key]
  if (!profiles?.length) {
    profiles = [{ id: `default-${key.slice(0, 16)}`, name: 'Default', agentsAllowed: false }]
    settings = {
      ...settings,
      browserProfiles: { ...settings.browserProfiles, [key]: profiles },
    }
    saveSettings(settings)
  }
  const activeId = settings.browserProfileDefaults?.[key]
  return {
    key,
    profiles,
    activeId: profiles.some((p) => p.id === activeId) ? activeId! : profiles[0]!.id,
    browserId: settings.browserDefaults?.[key],
  }
}

/** Keep OAuth popups opened by an extension inside its isolated browser profile and preserve
 * window.opener so the extension can receive the sign-in result. */
function allowExtensionAuthPopups(contents: WebContents, parent: BrowserWindow, session: Session) {
  contents.setWindowOpenHandler(({ url }) => {
    if (!/^https:\/\//i.test(url)) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        parent,
        width: 520,
        height: 700,
        autoHideMenuBar: true,
        backgroundColor: '#ffffff',
        webPreferences: {
          session,
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      },
    }
  })
  contents.on('did-create-window', (child) => {
    const guard = (event: { preventDefault(): void }, url: string) => {
      if (!/^https:\/\//i.test(url)) event.preventDefault()
    }
    child.webContents.on('will-navigate', (event) => guard(event, event.url))
    child.webContents.on('will-redirect', (event) => guard(event, event.url))
    allowExtensionAuthPopups(child.webContents, child, session)
  })
}

ipcMain.handle('beddcode:browser-profiles', async (event, raw: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  if (!win || event.sender !== win.webContents || !raw || typeof raw !== 'object') return null
  const request = raw as {
    action?: unknown
    projectPath?: unknown
    name?: unknown
    agentsAllowed?: unknown
    profileId?: unknown
    browserId?: unknown
    extensionKey?: unknown
    enabled?: unknown
    kind?: unknown
    currentUrl?: unknown
  }
  if (typeof request.projectPath !== 'string' || request.projectPath.length > 4096) return null
  const { key, profiles, activeId, browserId } = profilesFor(request.projectPath)
  const storedExtensions = (profileId: string) => settings.browserExtensions?.[profileId] ?? []
  const profileExtensionPaths = (profileId: string) =>
    storedExtensions(profileId)
      .filter((extension) => extension.enabled !== false)
      .map((extension) => extension.path)
  const publicExtensions = async (profileId: string): Promise<BrowserExtension[]> =>
    Promise.all(
      storedExtensions(profileId).map(async (extension) => {
        const pages = await extensionPagesAt(extension.path).catch(
          (): { actionPage?: string; settingsPage?: string } => ({}),
        )
        const name = await localizedExtensionName(extension.path, extension.name).catch(
          () => extension.name,
        )
        return {
          key: extension.key,
          name,
          enabled: extension.enabled !== false,
          hasAction: Boolean(pages.actionPage),
          hasOptions: Boolean(pages.settingsPage),
        }
      }),
    )
  if (request.action === 'list')
    return {
      profiles,
      activeId,
      browserId,
      extensions: await publicExtensions(activeId),
    }
  if (request.action === 'create') {
    const name = typeof request.name === 'string' ? request.name.trim().slice(0, 60) : ''
    if (!name || typeof request.agentsAllowed !== 'boolean' || profiles.length >= 30) return null
    const profile: BrowserProfile = { id: randomUUID(), name, agentsAllowed: request.agentsAllowed }
    const next = [...profiles, profile]
    settings = { ...settings, browserProfiles: { ...settings.browserProfiles, [key]: next } }
    saveSettings(settings)
    return next
  }
  if (request.action === 'select') {
    const profile = profiles.find((p) => p.id === request.profileId)
    if (!profile) return false
    settings = {
      ...settings,
      browserProfileDefaults: { ...settings.browserProfileDefaults, [key]: profile.id },
    }
    saveSettings(settings)
    const viewsForWindow = views.get(event.sender.id)
    viewsForWindow?.selectProfile(
      profile.id,
      profile.agentsAllowed,
      profileExtensionPaths(profile.id),
    )
    return true
  }
  if (request.action === 'agent-access') {
    const profileId = typeof request.profileId === 'string' ? request.profileId : activeId
    const profile = profiles.find((p) => p.id === profileId)
    if (!profile || typeof request.agentsAllowed !== 'boolean') return false
    const next = profiles.map((p) =>
      p.id === profile.id ? { ...p, agentsAllowed: request.agentsAllowed as boolean } : p,
    )
    settings = { ...settings, browserProfiles: { ...settings.browserProfiles, [key]: next } }
    saveSettings(settings)
    if (profile.id === activeId) {
      const viewsForWindow = views.get(event.sender.id)
      viewsForWindow?.selectProfile(
        profile.id,
        request.agentsAllowed,
        profileExtensionPaths(profile.id),
      )
    }
    return next
  }
  if (request.action === 'set-extension-enabled') {
    const profileId = typeof request.profileId === 'string' ? request.profileId : ''
    const extensionKey = typeof request.extensionKey === 'string' ? request.extensionKey : ''
    if (
      !profiles.some((profile) => profile.id === profileId) ||
      typeof request.enabled !== 'boolean'
    )
      return null
    const current = storedExtensions(profileId)
    const selected = current.find((extension) => extension.key === extensionKey)
    if (!selected) return null
    const next = current.map((extension) =>
      extension.key === extensionKey
        ? { ...extension, enabled: request.enabled as boolean }
        : extension,
    )
    const shared = browserSharedFor(profileId)
    if (request.enabled) {
      shared.configureExtensions(
        next.filter((extension) => extension.enabled !== false).map((ext) => ext.path),
      )
      await shared.loadExtension(selected.path)
    } else {
      await shared.removeExtension(selected.electronId)
      shared.configureExtensions(
        next.filter((extension) => extension.enabled !== false).map((ext) => ext.path),
      )
    }
    settings = {
      ...settings,
      browserExtensions: { ...settings.browserExtensions, [profileId]: next },
    }
    saveSettings(settings)
    browserSharedFor(profileId).configureExtensions(profileExtensionPaths(profileId))
    return await publicExtensions(profileId)
  }
  if (request.action === 'open-extension') {
    const profileId = typeof request.profileId === 'string' ? request.profileId : ''
    const extensionKey = typeof request.extensionKey === 'string' ? request.extensionKey : ''
    const kind = request.kind === 'settings' ? 'settings' : 'action'
    if (!profiles.some((profile) => profile.id === profileId)) return false
    const stored = storedExtensions(profileId).find((extension) => extension.key === extensionKey)
    if (!stored || stored.enabled === false) return false
    const shared = browserSharedFor(profileId)
    const loaded = await shared.loadExtension(stored.path)
    const pages = await extensionPagesAt(stored.path)
    const page = kind === 'settings' ? pages.settingsPage : pages.actionPage
    if (!page)
      throw new Error(
        `This extension does not provide a ${kind === 'settings' ? 'settings page' : 'toolbar popup'}.`,
      )
    const target = new URL(
      page.split('/').map(encodeURIComponent).join('/'),
      `${loaded.url.replace(/\/$/, '')}/`,
    ).toString()
    const currentUrl =
      typeof request.currentUrl === 'string' && /^https?:\/\//i.test(request.currentUrl)
        ? request.currentUrl
        : undefined
    const sourceBrowserId = stored.sourceBrowserId ?? settings.browserDefaults?.[key]
    const sourceBrowserName =
      installedBrowsers().find((browser) => browser.id === sourceBrowserId)?.name ?? 'your browser'
    const extensionWindow = new BrowserWindow({
      parent: win,
      width: kind === 'settings' ? 820 : 440,
      height: kind === 'settings' ? 720 : 640,
      minWidth: 360,
      minHeight: 320,
      show: false,
      autoHideMenuBar: true,
      title: `${stored.name}${kind === 'settings' ? ' settings' : ''}`,
      webPreferences: {
        session: shared.session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    })
    allowExtensionAuthPopups(extensionWindow.webContents, extensionWindow, shared.session)
    extensionWindow.once('ready-to-show', () => extensionWindow.show())
    try {
      await extensionWindow.loadURL(target)
    } catch (error) {
      extensionWindow.destroy()
      throw new Error(`Could not open ${stored.name}: ${String(error)}`)
    }
    const fallbackTimer = setTimeout(() => {
      if (extensionWindow.isDestroyed()) return
      void extensionWindow.webContents
        .executeJavaScript(
          `(() => {
            const body = document.body;
            if (!body) return true;
            if ((body.innerText || '').trim()) return false;
            const meaningful = body.querySelectorAll('button, a, input, select, textarea, img, svg, canvas, video, iframe, [role="button"], [role="menuitem"]');
            return ![...meaningful].some((element) => {
              const rect = element.getBoundingClientRect();
              const style = getComputedStyle(element);
              return rect.width > 4 && rect.height > 4 && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0;
            });
          })()`,
        )
        .then((blank: boolean) => {
          if (!blank || extensionWindow.isDestroyed()) return
          console.warn(
            `${stored.name} opened a blank extension page; showing native-browser fallback.`,
          )
          const openPage = currentUrl
            ? `<a href="${escapeHtml(currentUrl)}" target="_blank" rel="noreferrer">Open current page in ${escapeHtml(sourceBrowserName)}</a>`
            : '<p>Open a website in the browser pane first, then use this extension there.</p>'
          const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(stored.name)}</title><style>
            *{box-sizing:border-box}body{margin:0;min-height:100vh;background:#201f30;color:#f5f4fa;font:15px/1.55 system-ui,sans-serif;display:grid;place-items:center;padding:24px}
            main{width:min(440px,100%);padding:30px;border:1px solid #ffffff1a;border-radius:14px;background:#28273a;box-shadow:0 18px 60px #0005}
            h1{font-size:20px;line-height:1.25;margin:0 0 14px}p{color:#c4c2d0;margin:0 0 14px}
            a{display:inline-block;margin-top:6px;padding:10px 14px;border-radius:8px;background:#7665d5;color:white;text-decoration:none;font-weight:600}a:hover{background:#8978e8}
          </style></head><body><main><h1>${escapeHtml(stored.name)} needs its native browser</h1><p>This extension did not render in BeddCode’s built-in browser. It may use browser features that Electron does not support.</p>${openPage}</main></body></html>`
          return extensionWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
        })
        .catch((error: unknown) =>
          console.warn(`Could not display extension fallback: ${String(error)}`),
        )
    }, 3500)
    fallbackTimer.unref()
    return true
  }
  if (request.action === 'import-extensions') {
    const profileId = typeof request.profileId === 'string' ? request.profileId : ''
    if (!profiles.some((profile) => profile.id === profileId)) return null
    const browserId = typeof request.browserId === 'string' ? request.browserId : 'manual'
    if (browserId !== 'manual' && !installedBrowsers().some((browser) => browser.id === browserId))
      return null
    const browserName =
      browserId === 'manual'
        ? undefined
        : installedBrowsers().find((browser) => browser.id === browserId)?.name
    let manualFolder: string | undefined
    let profileFolder: string | undefined
    let sourceProfileName: string | undefined
    if (browserId === 'manual') {
      const folder = await dialog.showOpenDialog(win, {
        title: 'Choose an unpacked extension folder',
        buttonLabel: 'Add extension',
        properties: ['openDirectory'],
      })
      if (folder.canceled || !folder.filePaths[0]) return null
      manualFolder = folder.filePaths[0]
    } else {
      const root = browserUserDataRoot(browserId)
      const discovered = root
        ? browserId === 'firefox'
          ? await firefoxProfilesInRoot(root)
          : await chromiumProfilesInRoot(root)
        : []
      const selected = await chooseBrowserProfile(
        win,
        browserId,
        browserName ?? browserId,
        discovered,
      )
      if (selected) {
        profileFolder = selected.path
        sourceProfileName = selected.name
      } else if (!discovered.length) {
        const folder = await dialog.showOpenDialog(win, {
          title: `Find your ${browserName ?? 'browser'} profile`,
          buttonLabel: 'Use this folder',
          defaultPath: root,
          properties: ['openDirectory'],
        })
        if (folder.canceled || !folder.filePaths[0]) return null
        profileFolder =
          browserId === 'firefox'
            ? await resolveFirefoxProfileFolder(folder.filePaths[0])
            : await resolveChromiumProfileFolder(folder.filePaths[0])
        sourceProfileName = path.basename(profileFolder)
      } else {
        return null
      }
    }
    const current = storedExtensions(profileId)
    const available = Math.max(0, 40 - current.length)
    if (!available) throw new Error('This BeddCode profile already has 40 extensions.')
    let sources: Array<{ id?: string; name: string; path: string }>
    if (browserId === 'manual') {
      sources = [{ name: path.basename(manualFolder!), path: manualFolder! }]
    } else {
      sources =
        browserId === 'firefox'
          ? await installedFirefoxExtensions(profileFolder!)
          : await installedExtensionsInProfile(profileFolder!)
      if (!sources.length)
        throw new Error(
          `No enabled extensions were found in this ${browserName ?? 'browser'} profile. Select the profile you use in the browser.`,
        )
      const choice = await dialog.showMessageBox(win, {
        type: 'question',
        title: `Import ${browserName} extensions?`,
        message: `Found ${sources.length} enabled extension${sources.length === 1 ? '' : 's'} in ${sourceProfileName ?? 'this profile'}.`,
        detail: `${sources
          .slice(0, 18)
          .map((extension) => `• ${extension.name}`)
          .join(
            '\n',
          )}${sources.length > 18 ? `\n…and ${sources.length - 18} more` : ''}\n\nOnly enabled add-ons are copied. For Chromium browsers, BeddCode will also copy each extension’s saved local data into this project profile when available; this can include sign-in tokens. Close ${browserName} first for a more reliable copy. This stays on this device and in this project profile. ${browserId === 'firefox' ? 'Firefox XPI files are unpacked for Electron. Firefox extension data is not copied yet, and some Firefox-specific features may not work.' : 'Electron supports only a subset of Chrome extension APIs, so some extensions may not work.'}`,
        buttons: ['Import extensions and saved data', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
      })
      if (choice.response !== 0) return null
    }
    const shared = browserSharedFor(profileId)
    const targetStoragePath = shared.session.getStoragePath()
    shared.configureExtensions(
      current.filter((extension) => extension.enabled !== false).map((extension) => extension.path),
    )
    const next = [...current]
    let skipped = Math.max(0, sources.length - available)
    let extensionsWithSavedData = 0
    for (const source of sources.slice(0, available)) {
      if (
        next.some(
          (extension) =>
            extension.electronId === source.id ||
            extension.name.toLocaleLowerCase() === source.name.toLocaleLowerCase(),
        )
      ) {
        skipped++
        continue
      }
      let copied: Awaited<ReturnType<typeof copyUnpackedExtension>> | undefined
      try {
        copied = await copyUnpackedExtension(
          source.path,
          path.join(app.getPath('userData'), 'browser-extensions', profileId),
        )
        const savedStores =
          browserId !== 'firefox' && source.id && targetStoragePath
            ? await copyChromiumExtensionData(profileFolder!, targetStoragePath, source.id)
            : 0
        const loaded = await shared.loadExtension(copied.path)
        if (savedStores > 0 && loaded.id === source.id) extensionsWithSavedData++
        next.push({
          ...copied,
          name: source.id ? source.name : copied.name,
          electronId: loaded.id,
          enabled: true,
          ...(browserId !== 'manual' && { sourceBrowserId: browserId }),
        })
      } catch {
        skipped++
        if (copied) await rm(copied.path, { recursive: true, force: true })
      }
    }
    const addedCount = next.length - current.length
    if (!addedCount)
      throw new Error(
        'No new extensions were added. They may already be in this BeddCode profile or may not be supported by Electron.',
      )
    settings = {
      ...settings,
      browserExtensions: { ...settings.browserExtensions, [profileId]: next },
    }
    saveSettings(settings)
    return {
      extensions: await publicExtensions(profileId),
      imported: addedCount,
      skipped,
      extensionsWithSavedData,
    }
  }
  if (request.action === 'remove-extension') {
    const profileId = typeof request.profileId === 'string' ? request.profileId : ''
    const profile = profiles.find((candidate) => candidate.id === profileId)
    const extensionKey = typeof request.extensionKey === 'string' ? request.extensionKey : ''
    if (!profile || !extensionKey) return null
    const current = storedExtensions(profileId)
    const extension = current.find((candidate) => candidate.key === extensionKey)
    if (!extension) return null
    await browserSharedFor(profileId).removeExtension(extension.electronId)
    await rm(extension.path, { recursive: true, force: true })
    const next = current.filter((candidate) => candidate.key !== extensionKey)
    settings = {
      ...settings,
      browserExtensions: { ...settings.browserExtensions, [profileId]: next },
    }
    saveSettings(settings)
    browserSharedFor(profileId).configureExtensions(profileExtensionPaths(profileId))
    return await publicExtensions(profileId)
  }
  if (request.action === 'default-browser') {
    if (typeof request.browserId !== 'string') return false
    if (
      request.browserId !== 'system' &&
      !installedBrowsers().some((browser) => browser.id === request.browserId)
    )
      return false
    settings = {
      ...settings,
      browserDefaults: { ...settings.browserDefaults, [key]: request.browserId },
    }
    saveSettings(settings)
    return true
  }
  return null
})

ipcMain.handle('beddcode:installed-browsers', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  return win && event.sender === win.webContents
    ? installedBrowsers().map(({ id, name }) => ({ id, name }))
    : []
})

ipcMain.handle('beddcode:open-in-browser', (event, browserId: unknown, url: unknown) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  return Boolean(
    win &&
    event.sender === win.webContents &&
    typeof browserId === 'string' &&
    typeof url === 'string' &&
    openInBrowser(browserId, url),
  )
})

/** The whole app: its window and the host it supervises. */
function startApp() {
  // One app at a time: a second launch brings the first one forward instead of starting its own host.
  if (!app.requestSingleInstanceLock()) {
    app.quit()
  } else {
    app.on('second-instance', showWindow)
  }

  let stopping = false
  app.on('before-quit', () => {
    quitting = true
  })
  app.on('before-quit', (event) => {
    if (stopping || !daemon) return
    // Give the host a moment to shut down before the app goes.
    event.preventDefault()
    stopping = true
    void Promise.all([daemon.stop(), closeBrowserForwards()]).finally(() => app.quit())
  })

  app.whenReady().then(async () => {
    // Expose Electron's own UI to Windows UI Automation. Electron only allows this after ready.
    // Without Chromium accessibility, desktop agents can see the window but only get its title bar.
    app.setAccessibilitySupportEnabled(true)
    ElectronChromeExtensions.handleCRXProtocol(electronSession.defaultSession)

    settings = readDesktopSettings(settingsFile())
    browserShared()
    await startDaemon()
    if (process.platform !== 'darwin') createTray()
    createWindow()
    if (
      shouldAutoUpdate({ packaged: app.isPackaged, platform: process.platform, env: process.env })
    ) {
      autoUpdater.on('update-downloaded', (info) => {
        void dialog
          .showMessageBox({
            type: 'info',
            title: 'Update ready',
            message: `BeddCode ${info.version} is ready to install`,
            detail: 'Restart BeddCode to finish installing the update.',
            buttons: ['Restart and install', 'Later'],
            defaultId: 0,
            cancelId: 1,
          })
          .then(({ response }) => {
            if (response === 0) {
              quitting = true
              autoUpdater.quitAndInstall()
            }
          })
      })
      startAutoUpdate(autoUpdater, (message) => console.warn(message))
    }
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

// Started as `beddcode status` and the like, the app is the command line tool and opens no window.
const cli = cliLaunch({
  argv: process.argv,
  packaged: app.isPackaged,
  defaultApp: Boolean(process.defaultApp),
  resourcesPath: process.resourcesPath,
  execPath: process.execPath,
})
if (cli) {
  const child = spawn(cli.command, cli.args, {
    stdio: 'inherit',
    env: { ...process.env, ...cli.env },
  })
  child.on('error', (err) => {
    console.error(err.message)
    app.exit(1)
  })
  child.on('exit', (code) => app.exit(code ?? 1))
} else {
  startApp()
}
