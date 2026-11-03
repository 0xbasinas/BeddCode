import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * A host started by systemd, launchd or a scheduled task gets a bare PATH, so agent CLIs
 * installed for the user (~/.local/bin, nvm, ~/.grok/bin, …) look "not installed" there even
 * though a terminal finds them. This adds what the user's login shell sees, then the usual
 * per-user folders, after the PATH the host already has. Not used on Windows, where installers
 * put CLIs on the user PATH that a scheduled task already inherits.
 */
export function extendUserPath(
  current: string | undefined,
  deps: {
    home?: string
    loginShellPath?: () => string | undefined
    isDir?: (p: string) => boolean
    nvmBins?: (home: string) => string[]
  } = {},
): string {
  const home = deps.home ?? os.homedir()
  const isDir = deps.isDir ?? dirExists
  const fromShell = (deps.loginShellPath ?? loginShellPath)()
  const known = [
    path.join(home, '.local/bin'),
    path.join(home, 'bin'),
    ...(deps.nvmBins ?? nvmBins)(home),
    path.join(home, '.npm-global/bin'),
    path.join(home, '.bun/bin'),
    path.join(home, '.grok/bin'),
    path.join(home, '.cargo/bin'),
    '/usr/local/bin',
    '/opt/homebrew/bin',
  ].filter(isDir)
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of [...split(current), ...split(fromShell), ...known]) {
    if (!dir || seen.has(dir)) continue
    seen.add(dir)
    out.push(dir)
  }
  return out.join(path.delimiter)
}

const split = (p: string | undefined) => (p ?? '').split(path.delimiter).filter(Boolean)

function dirExists(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** PATH as the user's login shell sets it, or undefined when that takes too long or fails. */
function loginShellPath(): string | undefined {
  const shell = process.env.SHELL || '/bin/sh'
  const mark = '__BEDDCODE_PATH__'
  try {
    const r = spawnSync(shell, ['-lc', `printf '${mark}%s${mark}' "$PATH"`], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return new RegExp(`${mark}(.*?)${mark}`, 's').exec(r.stdout ?? '')?.[1]
  } catch {
    return undefined
  }
}

/** nvm's default Node (alias/default, else the newest installed), whose bin holds npm-installed CLIs. */
function nvmBins(home: string): string[] {
  const root = path.join(process.env.NVM_DIR || path.join(home, '.nvm'), 'versions/node')
  let versions: string[]
  try {
    versions = readdirSync(root).filter((v) => /^v\d+/.test(v))
  } catch {
    return []
  }
  const byVersion = (a: string, b: string) => {
    const pa = a.slice(1).split('.').map(Number)
    const pb = b.slice(1).split('.').map(Number)
    for (let i = 0; i < 3; i++)
      if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0)
    return 0
  }
  versions.sort(byVersion)
  let alias = ''
  try {
    alias = readFileSync(path.join(root, '../../alias/default'), 'utf8').trim().replace(/^v/, '')
  } catch {
    // no default alias: the newest version wins
  }
  const pick =
    (alias && versions.find((v) => v === `v${alias}` || v.startsWith(`v${alias}.`))) || versions[0]
  return pick ? [path.join(root, pick, 'bin')] : []
}
