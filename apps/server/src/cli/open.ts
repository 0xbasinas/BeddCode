import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

/**
 * `beddcode open`: starts the desktop app. The launcher the installer puts on PATH says where the
 * app is in BEDDCODE_APP; without it (a host-only install) there is nothing to open.
 */
export function openApp(env: NodeJS.ProcessEnv = process.env): number {
  const app = env.BEDDCODE_APP
  if (!app || !existsSync(app)) {
    console.error('The BeddCode app is not installed here (BEDDCODE_APP is not set).')
    return 1
  }
  // The launcher runs the app's executable as plain Node; the app itself must not.
  const clean = { ...env }
  delete clean.ELECTRON_RUN_AS_NODE
  spawn(app, [], { detached: true, stdio: 'ignore', env: clean }).unref()
  return 0
}
