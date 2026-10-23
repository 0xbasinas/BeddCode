import path from 'node:path'
import type { LaunchSpec } from './daemon.ts'

export const DEFAULT_PORT = 3773

export interface LaunchContext {
  /** Running from an installed build rather than the source tree. */
  packaged: boolean
  /** Folder installers put extra files in (the built host lives under `server/`). */
  resourcesPath: string
  /** The app's own executable; with ELECTRON_RUN_AS_NODE it runs scripts like Node does. */
  execPath: string
  /** apps/server in the source tree. */
  serverDir: string
  env: Record<string, string | undefined>
}

/** The port the local host listens on; the web app reaches it at the same one. */
export function hostPort(env: Record<string, string | undefined>): number {
  const port = Number(env.BEDDCODE_PORT)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_PORT
}

/**
 * How to start the local host:
 * - installed: the app's own runtime runs the built host that ships beside it,
 * - from source: the system Node runs the TypeScript sources (its native modules are built for it),
 * - `BEDDCODE_SERVER_ENTRY` points at a script to run instead (for trying a build).
 */
export function serverLaunch(context: LaunchContext): LaunchSpec {
  const port = String(hostPort(context.env))
  const entry = context.env.BEDDCODE_SERVER_ENTRY
  if (entry) {
    return {
      command: context.execPath,
      args: [entry, '--port', port],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    }
  }
  if (context.packaged) {
    return {
      command: context.execPath,
      args: [path.join(context.resourcesPath, 'server', 'main.mjs'), '--port', port],
      // The host serves the built web app that ships beside it.
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        BEDDCODE_WEB_ROOT: path.join(context.resourcesPath, 'web'),
      },
    }
  }
  return {
    command: 'node',
    args: ['--import', 'tsx', 'src/main.ts', '--port', port],
    cwd: context.serverDir,
  }
}
