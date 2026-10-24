import path from 'node:path'
import type { LaunchSpec } from './daemon.ts'

/** What `beddcode <command>` can be when the installed app's own executable is run. */
const COMMANDS = new Set([
  'ls',
  'run',
  'attach',
  'send',
  'stop',
  'approve',
  'undo',
  'schedule',
  'alert',
  'projects',
  'devices',
  'revoke',
  'hosts',
  'config',
  'status',
  'open',
  'pair',
  'logs',
  'doctor',
  'report',
  'update',
  'completion',
  'host',
  'serve',
  'install-service',
  'uninstall-service',
  'help',
  '--help',
  '-h',
])

export interface CliContext {
  argv: string[]
  /** Running from an installed build; from source the commands are `pnpm --filter @beddcode/server start`. */
  packaged: boolean
  /** Started as `electron <app>`, where the arguments begin one place later. */
  defaultApp: boolean
  resourcesPath: string
  execPath: string
}

/**
 * When the app is started as `beddcode status` (or pair, logs, doctor, …) from a terminal, it should
 * act as the command line tool and not open a window: the host's own script runs on the app's
 * runtime, as plain Node. Null when this is an ordinary launch of the app.
 */
export function cliLaunch(context: CliContext): LaunchSpec | null {
  if (!context.packaged) return null
  const args = context.argv.slice(context.defaultApp ? 2 : 1)
  if (!args[0] || !COMMANDS.has(args[0])) return null
  return {
    command: context.execPath,
    args: [path.join(context.resourcesPath, 'server', 'main.mjs'), ...args],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      // The host's database module prints an experimental-feature notice that is noise in a terminal.
      NODE_NO_WARNINGS: '1',
      // `beddcode open` starts this app again; the bare command shows help.
      BEDDCODE_APP: context.execPath,
      BEDDCODE_WEB_ROOT: path.join(context.resourcesPath, 'web'),
    },
  }
}
