import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { VERSION } from '../version.ts'
import { parseArgs } from './args.ts'
import type { Ctx } from './sessionCmds.ts'

const REPO = '0xbasinas/BeddCode'

export interface Release {
  tag_name: string
  html_url: string
  assets: { name: string; browser_download_url: string }[]
}

/** 1 when `a` is newer than `b`, -1 when older, 0 when the same. Ignores a leading v and any suffix. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map((n) => Number.parseInt(n, 10) || 0)
  const x = parts(a)
  const y = parts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d > 0 ? 1 : -1
  }
  return 0
}

/** The installer for this system among a release's files. */
export function pickAsset(
  assets: Release['assets'],
  platform: NodeJS.Platform,
  arch: string,
  preferDeb = false,
): Release['assets'][number] | undefined {
  const named = (re: RegExp) =>
    assets.filter((a) => re.test(a.name) && !a.name.endsWith('.blockmap'))
  const byArch = (list: Release['assets']) =>
    list.find((a) => (arch === 'arm64' ? /arm64|aarch64/i : /x64|amd64|x86_64/i).test(a.name)) ??
    list[0]
  if (platform === 'win32') return byArch(named(/\.exe$/i))
  if (platform === 'darwin') return byArch(named(/\.dmg$/i))
  return (
    byArch(named(preferDeb ? /\.deb$/i : /\.AppImage$/i)) ?? byArch(named(/\.(AppImage|deb)$/i))
  )
}

export interface UpdateDeps {
  fetch: typeof fetch
  platform: NodeJS.Platform
  arch: string
  current: string
  download(url: string, file: string): Promise<void>
}

export async function latestRelease(f: typeof fetch): Promise<Release> {
  const res = await f(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'beddcode-cli' },
  })
  if (!res.ok) throw new Error(`GitHub answered ${res.status}; try again later.`)
  return (await res.json()) as Release
}

const realDeps = (): UpdateDeps => ({
  fetch,
  platform: process.platform,
  arch: process.arch,
  current: VERSION,
  async download(url, file) {
    const res = await fetch(url, { headers: { 'user-agent': 'beddcode-cli' } })
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)
    await mkdir(path.dirname(file), { recursive: true })
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file))
  },
})

/**
 * `beddcode update`: says whether a newer release exists. The desktop app updates itself and winget
 * upgrades it, so this only fetches an installer when asked (`--download [folder]`).
 * Exit 0 when current, 10 when an update is available (handy in scripts), 1 on error.
 */
export async function updateCmd(
  args: string[],
  ctx: Ctx,
  deps: UpdateDeps = realDeps(),
): Promise<number> {
  const { flags } = parseArgs(args, { bool: ['download', 'deb'], string: ['out'] })
  const release = await latestRelease(deps.fetch)
  const newer = compareVersions(release.tag_name, deps.current) > 0
  if (!newer) {
    ctx.io.out(`BeddCode ${deps.current} is up to date.\n`)
    return 0
  }
  ctx.io.out(
    `BeddCode ${release.tag_name} is available (you have ${deps.current}).\n${release.html_url}\n`,
  )
  if (flags.download === true) {
    const asset = pickAsset(release.assets, deps.platform, deps.arch, flags.deb === true)
    if (!asset) {
      ctx.io.err('This release has no installer for this system.\n')
      return 1
    }
    const file = path.resolve(typeof flags.out === 'string' ? flags.out : '.', asset.name)
    ctx.io.err(`Downloading ${asset.name}…\n`)
    await deps.download(asset.browser_download_url, file)
    ctx.io.out(`${file}\n`)
  } else {
    ctx.io.err(
      deps.platform === 'win32'
        ? 'Update with `winget upgrade BeddCode.BeddCode`, or let the app update itself, or run `beddcode update --download`.\n'
        : 'The app updates itself; or run `beddcode update --download` to fetch the installer.\n',
    )
  }
  return 10
}
