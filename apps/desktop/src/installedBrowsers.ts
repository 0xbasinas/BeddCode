import { existsSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import type { InstalledBrowser } from '@beddcode/contracts'

interface BrowserInstall extends InstalledBrowser {
  executable: string
}

const candidates: Partial<
  Record<
    NodeJS.Platform,
    Array<{ id: string; name: string; paths: (env: NodeJS.ProcessEnv) => string[] }>
  >
> = {
  win32: [
    {
      id: 'chrome',
      name: 'Google Chrome',
      paths: (e) => [
        path.join(
          e.ProgramW6432 ?? e.PROGRAMFILES ?? 'C:\\Program Files',
          'Google/Chrome/Application/chrome.exe',
        ),
        path.join(e.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
        path.join(
          e['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
          'Google/Chrome/Application/chrome.exe',
        ),
        path.join(e.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
        ...windowsRegisteredBrowserPaths('chrome.exe'),
      ],
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      paths: (e) => [
        path.join(e.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft/Edge/Application/msedge.exe'),
        path.join(
          e['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
          'Microsoft/Edge/Application/msedge.exe',
        ),
      ],
    },
    {
      id: 'brave',
      name: 'Brave',
      paths: (e) => [
        path.join(
          e.PROGRAMFILES ?? 'C:\\Program Files',
          'BraveSoftware/Brave-Browser/Application/brave.exe',
        ),
        path.join(e.LOCALAPPDATA ?? '', 'BraveSoftware/Brave-Browser/Application/brave.exe'),
      ],
    },
    {
      id: 'firefox',
      name: 'Firefox',
      paths: (e) => [
        path.join(e.PROGRAMFILES ?? 'C:\\Program Files', 'Mozilla Firefox/firefox.exe'),
        path.join(
          e['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)',
          'Mozilla Firefox/firefox.exe',
        ),
      ],
    },
    {
      id: 'arc',
      name: 'Arc',
      paths: (e) => [path.join(e.LOCALAPPDATA ?? '', 'Programs/Arc/Application/Arc.exe')],
    },
    {
      id: 'vivaldi',
      name: 'Vivaldi',
      paths: (e) => [
        path.join(e.LOCALAPPDATA ?? '', 'Vivaldi/Application/vivaldi.exe'),
        path.join(e.PROGRAMFILES ?? 'C:\\Program Files', 'Vivaldi/Application/vivaldi.exe'),
      ],
    },
    {
      id: 'opera',
      name: 'Opera',
      paths: (e) => [
        path.join(e.LOCALAPPDATA ?? '', 'Programs/Opera/launcher.exe'),
        path.join(e.PROGRAMFILES ?? 'C:\\Program Files', 'Opera/launcher.exe'),
      ],
    },
  ],
  darwin: [
    {
      id: 'chrome',
      name: 'Google Chrome',
      paths: () => [
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      ],
    },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      paths: () => [
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        path.join(os.homedir(), 'Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
      ],
    },
    {
      id: 'brave',
      name: 'Brave',
      paths: () => [
        '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
        path.join(os.homedir(), 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser'),
      ],
    },
    {
      id: 'firefox',
      name: 'Firefox',
      paths: () => [
        '/Applications/Firefox.app/Contents/MacOS/firefox',
        path.join(os.homedir(), 'Applications/Firefox.app/Contents/MacOS/firefox'),
      ],
    },
    {
      id: 'arc',
      name: 'Arc',
      paths: () => [
        '/Applications/Arc.app/Contents/MacOS/Arc',
        path.join(os.homedir(), 'Applications/Arc.app/Contents/MacOS/Arc'),
      ],
    },
    {
      id: 'vivaldi',
      name: 'Vivaldi',
      paths: () => [
        '/Applications/Vivaldi.app/Contents/MacOS/Vivaldi',
        path.join(os.homedir(), 'Applications/Vivaldi.app/Contents/MacOS/Vivaldi'),
      ],
    },
    {
      id: 'opera',
      name: 'Opera',
      paths: () => [
        '/Applications/Opera.app/Contents/MacOS/Opera',
        path.join(os.homedir(), 'Applications/Opera.app/Contents/MacOS/Opera'),
      ],
    },
  ],
  linux: [
    {
      id: 'chrome',
      name: 'Google Chrome',
      paths: () => commands(['google-chrome', 'google-chrome-stable', 'google-chrome-beta']),
    },
    { id: 'chromium', name: 'Chromium', paths: () => commands(['chromium', 'chromium-browser']) },
    {
      id: 'edge',
      name: 'Microsoft Edge',
      paths: () => commands(['microsoft-edge', 'microsoft-edge-stable']),
    },
    { id: 'brave', name: 'Brave', paths: () => commands(['brave-browser', 'brave']) },
    { id: 'firefox', name: 'Firefox', paths: () => commands(['firefox']) },
    { id: 'vivaldi', name: 'Vivaldi', paths: () => commands(['vivaldi']) },
    { id: 'opera', name: 'Opera', paths: () => commands(['opera']) },
  ],
}

function commands(names: string[]): string[] {
  return names.flatMap((name) => {
    try {
      return [
        execFileSync('which', [name], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim(),
      ]
    } catch {
      return []
    }
  })
}

function windowsRegisteredBrowserPaths(appName: string): string[] {
  if (process.platform !== 'win32') return []
  const paths: string[] = []
  for (const hive of ['HKCU', 'HKLM']) {
    try {
      const output = execFileSync(
        'reg.exe',
        [
          'query',
          `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${appName}`,
          '/ve',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      )
      const executable = output
        .match(/\(Default\)\s+REG_SZ\s+(.+)/i)?.[1]
        ?.trim()
        .replace(/^"|"$/g, '')
      if (executable) paths.push(executable)
    } catch {
      // Per-user and portable installs do not always register an App Paths entry.
    }
  }
  return paths
}

export function installedBrowsers(): BrowserInstall[] {
  return (candidates[process.platform] ?? []).flatMap((candidate) => {
    const executable = candidate.paths(process.env).find((file) => file && existsSync(file))
    return executable ? [{ id: candidate.id, name: candidate.name, executable }] : []
  })
}

/** The browser's user-data root; the user can pick the profile they actually use. */
export function browserUserDataRoot(browserId: string): string | undefined {
  const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData/Local')
  const roaming = process.env.APPDATA ?? path.join(os.homedir(), 'AppData/Roaming')
  const support = path.join(os.homedir(), 'Library/Application Support')
  const config = path.join(os.homedir(), '.config')
  const roots: Record<string, string[]> = {
    chrome: [
      ...(process.env.CHROME_USER_DATA_DIR ? [process.env.CHROME_USER_DATA_DIR] : []),
      path.join(local, 'Google/Chrome/User Data'),
      path.join(support, 'Google/Chrome'),
      path.join(config, 'google-chrome'),
      path.join(config, 'google-chrome-unstable'),
    ],
    chromium: [path.join(support, 'Chromium'), path.join(config, 'chromium')],
    edge: [
      path.join(local, 'Microsoft/Edge/User Data'),
      path.join(support, 'Microsoft Edge'),
      path.join(config, 'microsoft-edge'),
    ],
    brave: [
      path.join(local, 'BraveSoftware/Brave-Browser/User Data'),
      path.join(support, 'BraveSoftware/Brave-Browser'),
      path.join(config, 'BraveSoftware/Brave-Browser'),
    ],
    vivaldi: [
      path.join(local, 'Vivaldi/User Data'),
      path.join(support, 'Vivaldi'),
      path.join(config, 'vivaldi'),
    ],
    opera: [
      path.join(roaming, 'Opera Software/Opera Stable'),
      path.join(support, 'com.operasoftware.Opera'),
      path.join(config, 'opera'),
    ],
    arc: [path.join(support, 'Arc/User Data')],
    firefox: [
      path.join(roaming, 'Mozilla/Firefox/Profiles'),
      path.join(roaming, 'Mozilla/Firefox'),
      path.join(support, 'Firefox/Profiles'),
      path.join(os.homedir(), '.mozilla/firefox'),
    ],
  }
  return (roots[browserId] ?? []).find((candidate) => existsSync(candidate))
}

export function openInBrowser(browserId: string, url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  const browser = installedBrowsers().find((entry) => entry.id === browserId)
  if (!browser) return false
  const child = spawn(browser.executable, [url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
  return true
}
