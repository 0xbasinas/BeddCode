import { readFile, readdir } from 'node:fs/promises'
import { runCommand, type RunResult } from './process.ts'

export interface ProcessMemoryDeps {
  platform?: NodeJS.Platform
  readFile?: (path: string) => Promise<string>
  readdir?: (path: string) => Promise<string[]>
  run?: (file: string, args: string[], options: { timeoutMs: number }) => Promise<RunResult>
  timeoutMs?: number
}

/** Used when a process cannot be measured, so the pool still counts it against its cap. */
export const ESTIMATED_PROCESS_BYTES = 256 * 1024 * 1024

const MAX_PROCESSES = 256

/**
 * Resident bytes of a process (with its children where the platform makes that cheap), or null
 * when it cannot be read. Never throws.
 */
export async function readProcessMemory(
  pid: number | undefined,
  deps: ProcessMemoryDeps = {},
): Promise<number | null> {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return null
  const platform = deps.platform ?? process.platform
  const timeoutMs = deps.timeoutMs ?? 5_000
  const run = deps.run ?? ((file, args, options) => runCommand(file, args, options))
  try {
    if (platform === 'linux') return await linux(pid, deps)
    if (platform === 'win32') return await windows(pid, run, timeoutMs)
    return await unix(pid, run, timeoutMs)
  } catch {
    return null
  }
}

/** The measured size, or the estimate when it cannot be measured. */
export async function measureProcessMemory(
  pid: number | undefined,
  deps: ProcessMemoryDeps = {},
): Promise<number> {
  return (await readProcessMemory(pid, deps)) ?? ESTIMATED_PROCESS_BYTES
}

async function linux(pid: number, deps: ProcessMemoryDeps): Promise<number | null> {
  const read = deps.readFile ?? ((path) => readFile(path, 'utf8'))
  const list = deps.readdir ?? ((path) => readdir(path))
  const rss = async (id: number): Promise<number | null> => {
    const match = /^VmRSS:\s+(\d+)\s*kB/m.exec(await read(`/proc/${id}/status`))
    return match ? Number(match[1]) * 1024 : null
  }
  const root = await rss(pid)
  if (root === null) return null
  let total = root
  const seen = new Set([pid])
  const queue = [pid]
  while (queue.length && seen.size < MAX_PROCESSES) {
    const id = queue.shift()!
    let children: number[] = []
    try {
      for (const task of await list(`/proc/${id}/task`)) {
        const text = await read(`/proc/${id}/task/${task}/children`).catch(() => '')
        children = children.concat(text.split(/\s+/).filter(Boolean).map(Number))
      }
    } catch {
      // Children are best effort: the process itself was measured.
    }
    for (const child of children) {
      if (!Number.isInteger(child) || child <= 0 || seen.has(child)) continue
      seen.add(child)
      queue.push(child)
      total += (await rss(child).catch(() => null)) ?? 0
    }
  }
  return total
}

async function windows(
  pid: number,
  run: NonNullable<ProcessMemoryDeps['run']>,
  timeoutMs: number,
): Promise<number | null> {
  const result = await run('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { timeoutMs })
  if (result.code !== 0) return null
  for (const line of result.stdout.split(/\r?\n/)) {
    const fields = [...line.matchAll(/"([^"]*)"/g)].map((m) => m[1]!)
    if (fields.length < 5 || Number(fields[1]) !== pid) continue
    // "Mem Usage" looks like "12,345 K" (the separator is locale dependent).
    const kb = Number(fields[4]!.replace(/\D/g, ''))
    return fields[4]!.trim() && Number.isFinite(kb) ? kb * 1024 : null
  }
  return null
}

async function unix(
  pid: number,
  run: NonNullable<ProcessMemoryDeps['run']>,
  timeoutMs: number,
): Promise<number | null> {
  const result = await run('ps', ['-o', 'rss=', '-p', String(pid)], { timeoutMs })
  if (result.code !== 0) return null
  const kb = Number(result.stdout.trim())
  return /^\d+$/.test(result.stdout.trim()) && Number.isFinite(kb) ? kb * 1024 : null
}
