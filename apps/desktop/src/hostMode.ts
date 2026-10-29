import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

/**
 * Where the app's host comes from:
 * - `auto`: the background host when one is installed (`beddcode host install` or the host-only
 *   installer), started if it is not running; otherwise a host already running, otherwise its own,
 * - `app`: a host already running, otherwise the app starts its own (and stops it when it quits),
 * - `external`: only a host started separately; the app never starts one of its own.
 */
export type HostMode = 'auto' | 'app' | 'external'
export const HOST_MODES: readonly HostMode[] = ['auto', 'app', 'external']

export const isHostMode = (value: unknown): value is HostMode =>
  typeof value === 'string' && (HOST_MODES as readonly string[]).includes(value)

/** The mode in effect: BEDDCODE_HOST_MODE, then BEDDCODE_NO_DAEMON=1 (external), then the setting. */
export function resolveHostMode(
  setting: HostMode | undefined,
  env: Record<string, string | undefined>,
): HostMode {
  if (isHostMode(env.BEDDCODE_HOST_MODE)) return env.BEDDCODE_HOST_MODE
  if (env.BEDDCODE_NO_DAEMON === '1') return 'external'
  return setting ?? 'auto'
}

export interface HostPlan {
  /** The app may start a host of its own when none answers. */
  spawn: boolean
  /** The app starts the installed background host when none answers. */
  useService: boolean
}

/**
 * What the app does for a mode, given whether a background host is installed for the app's port.
 * With one installed the app never starts a second host next to it: both would want the same port.
 * (One on another port is no help to the app, and no obstacle, so callers pass false for it.)
 */
export function planHost(mode: HostMode, serviceInstalled: boolean): HostPlan {
  switch (mode) {
    case 'app':
      return { spawn: true, useService: false }
    case 'external':
      return { spawn: false, useService: serviceInstalled }
    default:
      return serviceInstalled
        ? { spawn: false, useService: true }
        : { spawn: true, useService: false }
  }
}

/** What the app says while it waits for a host it does not start itself. */
export function waitingDetail(plan: HostPlan, port: number, platform: NodeJS.Platform): string {
  if (plan.useService) {
    return `Starting the background host (${platform === 'win32' ? 'the "BeddCode Server" scheduled task' : 'the beddcode-server user service'}) on port ${port}. If it does not answer, run \`beddcode host status\` or \`beddcode logs\`.`
  }
  return `Waiting for a BeddCode host on port ${port}. Start one with \`beddcode serve\` or \`beddcode host install\`, or choose "Let the app start its own" under Host in the tray menu.`
}

// The background host's names, as apps/server/src/service/install.ts gives them.
export const WINDOWS_TASK = 'BeddCode Server'
export const SYSTEMD_UNIT = 'beddcode-server.service'

type Run = (file: string, args: string[]) => Promise<number>

const runReal: Run = (file, args) =>
  new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 10_000 }, (err) => {
      if (!err) return resolve(0)
      const code = (err as { code?: unknown }).code
      resolve(typeof code === 'number' ? code : 1)
    })
  })

/** Commands to ask about and start the background host on this system, or null where there is none. */
export function serviceCommands(
  platform: NodeJS.Platform,
): { query: [string, string[]]; start: [string, string[]] } | null {
  if (platform === 'win32') {
    return {
      query: ['schtasks', ['/Query', '/TN', WINDOWS_TASK]],
      start: ['schtasks', ['/Run', '/TN', WINDOWS_TASK]],
    }
  }
  if (platform === 'linux') {
    return {
      query: ['systemctl', ['--user', 'is-enabled', SYSTEMD_UNIT]],
      start: ['systemctl', ['--user', 'start', SYSTEMD_UNIT]],
    }
  }
  return null
}

/** Whether the background host is installed on this machine. */
export async function backgroundHostInstalled(
  platform: NodeJS.Platform = process.platform,
  run: Run = runReal,
): Promise<boolean> {
  const commands = serviceCommands(platform)
  if (!commands) return false
  return (await run(...commands.query)) === 0
}

/** Asks the background host to start (it is a no-op when it already runs). */
export async function startBackgroundHost(
  platform: NodeJS.Platform = process.platform,
  run: Run = runReal,
): Promise<void> {
  const commands = serviceCommands(platform)
  if (commands) await run(...commands.start)
}

/** Where `beddcode host install` keeps the background host's definition (see install.ts). */
export function serviceFile(platform: NodeJS.Platform, home: string): string | null {
  if (platform === 'win32')
    return path.win32.join(home, 'AppData', 'Local', 'BeddCode', 'host-task.xml')
  if (platform === 'linux')
    return path.posix.join(home, '.config', 'systemd', 'user', 'beddcode-server.service')
  return null
}

/** The port in a service definition's `serve` arguments (3773 when it names none). */
export function servicePortOf(definition: string): number {
  const match = /--port(?:=|\s+)(\d+)/.exec(definition)
  return match ? Number(match[1]) : 3773
}

/**
 * The port the installed background host listens on, as its definition says; null when it cannot be
 * read. The task's XML is UTF-16, the unit plain text.
 */
export function backgroundHostPort(
  platform: NodeJS.Platform,
  home: string,
  read: (file: string) => Buffer = (file) => readFileSync(file),
): number | null {
  const file = serviceFile(platform, home)
  if (!file) return null
  try {
    const bytes = read(file)
    const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe
    return servicePortOf(utf16 ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8'))
  } catch {
    return null
  }
}
