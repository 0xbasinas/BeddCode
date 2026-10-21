import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { chmod, mkdir, readdir, realpath, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { runCommand, type RunResult } from '@beddcode/shared'
import { z } from 'zod'
import type { LaunchSpec, RegistryAgent } from './registry.ts'

const BinaryEntry = z.object({
  archive: z.string(),
  cmd: z.string(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  sha256: z.string().optional(),
})
export type BinaryTarget = z.infer<typeof BinaryEntry>

/** The registry's platform key for this machine, e.g. `windows-x86_64` or `linux-aarch64`. */
export function currentPlatform(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'darwin' : 'linux'
  const cpu = arch === 'arm64' ? 'aarch64' : 'x86_64'
  return `${os}-${cpu}`
}

/** The download for one platform, when the agent ships one. */
export function binaryFor(
  agent: RegistryAgent,
  platform = currentPlatform(),
): BinaryTarget | undefined {
  const raw = agent.distribution.binary?.[platform]
  const parsed = BinaryEntry.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}

export type InstallPlan =
  | { type: 'run'; launch: LaunchSpec }
  | { type: 'download'; target: BinaryTarget; host: string; verified: boolean }
  | { type: 'unavailable'; reason: string }

/** What adding an agent would do on this machine: run a package tool, download a program, or nothing. */
export function planInstall(
  agent: RegistryAgent,
  launch: LaunchSpec | undefined,
  platform = currentPlatform(),
): InstallPlan {
  if (launch) return { type: 'run', launch }
  const target = binaryFor(agent, platform)
  if (target) {
    let host = ''
    try {
      host = new URL(target.archive).host
    } catch {
      return { type: 'unavailable', reason: 'The registry lists an invalid download address' }
    }
    return { type: 'download', target, host, verified: Boolean(target.sha256) }
  }
  return agent.distribution.binary
    ? { type: 'unavailable', reason: `No build for this machine (${platform})` }
    : { type: 'unavailable', reason: 'No way to run this agent was listed' }
}

type Run = (file: string, args: string[], cwd?: string) => Promise<RunResult>

export interface InstallOptions {
  /** Folder holding installed agents, one subfolder per agent and version. */
  root: string
  fetch?: typeof fetch
  platform?: string
  /** Runs the archive tool; injected in tests. */
  run?: Run
  /** Accept http:// downloads from this machine. Tests only. */
  allowLocalHttp?: boolean
  maxBytes?: number
}

const DEFAULT_MAX_BYTES = 600 * 1024 * 1024
const safe = (text: string) => text.replace(/[^a-zA-Z0-9._-]+/g, '_')

function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Windows ships bsdtar, which reads zip files too; a `tar` found on PATH may be GNU tar, which does not. */
function tarTool(): string {
  return process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
}

async function extract(archive: string, into: string, name: string, run: Run) {
  const lower = name.toLowerCase()
  let result: RunResult
  if (lower.endsWith('.zip')) {
    result =
      process.platform === 'win32'
        ? await run(tarTool(), ['-xf', archive, '-C', into])
        : await run('unzip', ['-q', '-o', archive, '-d', into])
  } else if (/\.(tar\.gz|tgz|tar\.bz2|tbz2|tar\.xz|txz|tar)$/.test(lower)) {
    result = await run(tarTool(), ['-xf', archive, '-C', into])
  } else {
    // A bare executable: keep it under its own name.
    await rename(archive, path.join(into, path.basename(name)))
    return
  }
  if (result.code !== 0) {
    throw new Error(`Could not unpack the download: ${(result.stderr || result.stdout).trim()}`)
  }
}

/** Every file must really live under the install folder; a link that leads elsewhere is refused. */
async function assertContained(dir: string) {
  const base = await realpath(dir)
  const walk = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (!isInside(base, await realpath(full))) {
        throw new Error('The download contains a link that points outside its folder')
      }
      if (entry.isDirectory()) await walk(full)
    }
  }
  await walk(base)
}

/**
 * Downloads an agent's program, checks it against the registry's checksum, unpacks it and returns
 * how to launch it. Only https downloads, only the address the registry lists, nothing is run.
 */
export async function installBinary(
  agent: RegistryAgent,
  options: InstallOptions,
): Promise<LaunchSpec> {
  const target = binaryFor(agent, options.platform)
  if (!target) throw new Error(`${agent.name} has no download for this machine`)

  const url = new URL(target.archive)
  const local = options.allowLocalHttp && ['localhost', '127.0.0.1'].includes(url.hostname)
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error('Downloads must use https')
  }

  const dir = path.join(options.root, safe(agent.id), safe(agent.version))
  const command = path.resolve(dir, target.cmd)
  if (!isInside(dir, command)) throw new Error('The registry points outside the install folder')
  const launch: LaunchSpec = { command, args: target.args ?? [], env: target.env ?? {} }
  if (existsSync(command)) return launch // installed earlier

  const name = path.basename(decodeURIComponent(url.pathname)) || 'download'
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const file = path.join(dir, `.download-${safe(name)}`)
  try {
    const res = await (options.fetch ?? fetch)(url, { signal: AbortSignal.timeout(10 * 60_000) })
    if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`)

    const max = options.maxBytes ?? DEFAULT_MAX_BYTES
    const hash = createHash('sha256')
    let size = 0
    await pipeline(
      Readable.fromWeb(res.body as never),
      new Transform({
        transform(chunk: Buffer, _enc, done) {
          size += chunk.length
          if (size > max) return done(new Error('The download is larger than expected'))
          hash.update(chunk)
          done(null, chunk)
        },
      }),
      createWriteStream(file),
    )
    if (target.sha256 && hash.digest('hex') !== target.sha256.toLowerCase()) {
      throw new Error('The download does not match its published checksum, so it was discarded')
    }

    await extract(
      file,
      dir,
      name,
      options.run ?? ((f, a, c) => runCommand(f, a, { cwd: c, timeoutMs: 5 * 60_000 })),
    )
    await rm(file, { force: true })
    await assertContained(dir)
    if (!existsSync(command)) throw new Error(`The download did not contain ${target.cmd}`)
    if (!(await stat(command)).isFile()) throw new Error(`${target.cmd} is not a program`)
    if (process.platform !== 'win32') await chmod(command, 0o755)
    return launch
  } catch (err) {
    // A half-installed agent must not look installed next time.
    await rm(dir, { recursive: true, force: true })
    throw err
  }
}

/** Removes what `installBinary` put on disk for an agent (all its versions). */
export async function removeInstall(root: string, agentId: string): Promise<boolean> {
  const dir = path.join(root, safe(agentId))
  if (!isInside(root, dir) || !existsSync(dir)) return false
  await rm(dir, { recursive: true, force: true })
  return true
}
