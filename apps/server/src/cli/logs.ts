import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  watchFile,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Where the desktop app keeps the log of the host it supervises (see apps/desktop/src/main.ts). */
export function hostLogPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home = os.homedir(),
): string {
  if (env.BEDDCODE_LOG_FILE) return env.BEDDCODE_LOG_FILE
  const base =
    platform === 'win32'
      ? (env.APPDATA ?? path.join(home, 'AppData', 'Roaming'))
      : platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support')
        : (env.XDG_CONFIG_HOME ?? path.join(home, '.config'))
  return path.join(base, 'BeddCode', 'logs', 'host.log')
}

export function tail(text: string, lines: number): string {
  return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')
}

/** `beddcode logs [-n lines] [-f]`: the host's log; `-f` keeps printing what is added. */
export function logs(
  file: string,
  options: { lines: number; follow: boolean },
  out: (text: string) => void = (t) => console.log(t),
): number {
  if (!existsSync(file)) {
    console.error(`No log at ${file}. The app writes it when it starts its own host.`)
    return 1
  }
  const shown = tail(readFileSync(file, 'utf8'), options.lines)
  if (shown) out(shown)
  if (options.follow) {
    let offset = statSync(file).size
    watchFile(file, { interval: 500 }, (now) => {
      if (now.size < offset) offset = 0 // the log was rotated
      if (now.size === offset) return
      const fd = openSync(file, 'r')
      try {
        const buffer = Buffer.alloc(now.size - offset)
        readSync(fd, buffer, 0, buffer.length, offset)
        out(buffer.toString('utf8').replace(/\r?\n$/, ''))
      } finally {
        closeSync(fd)
      }
      offset = now.size
    })
  }
  return 0
}
