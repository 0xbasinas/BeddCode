import type { HostStats } from '@beddcode/contracts'
import { parseArgs, str } from './args.ts'
import { connect, type Conn } from './connection.ts'
import { allTargets, pickTargets } from './hosts.ts'
import type { Ctx } from './sessionCmds.ts'

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

const fmtDuration = (seconds: number) => {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m ${Math.floor(seconds % 60)}s`
}

/** The stats as a table: what the host is doing and how much its data folder weighs. */
export function formatStats(stats: HostStats): string {
  const s = stats.sessions
  const lines: string[] = [
    `${stats.host.name}  (${stats.host.hostId.slice(0, 8)}, ${stats.host.platform}, v${stats.host.version})`,
    `up ${fmtDuration(stats.uptimeSeconds)}, log seq ${stats.seq}, ${stats.clients.websockets} client(s)`,
    '',
    `sessions   ${s.total}  (${
      Object.entries(s.byStatus)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}: ${n}`)
        .join(', ') || 'none'
    })`,
    `active     ${s.activeTurns} turn(s), ${s.activeTools} tool call(s); waiting on you: ${s.openRequests}; queued: ${s.queuedPrompts}; pinned: ${s.pinned}`,
    `storage    db ${fmtBytes(stats.storage.dbBytes)}, attachments ${fmtBytes(stats.storage.attachmentsBytes)}, stale worktrees: ${stats.storage.staleWorktrees.length}`,
  ]
  const counters = Object.entries(stats.counters)
  if (counters.length > 0) {
    lines.push('', 'since start')
    for (const [name, value] of counters) lines.push(`  ${name.padEnd(34)} ${value}`)
  }
  if (stats.storage.staleWorktrees.length > 0) {
    lines.push('', 'stale worktrees (no session uses them):')
    for (const w of stats.storage.staleWorktrees.slice(0, 10)) lines.push(`  ${w}`)
    if (stats.storage.staleWorktrees.length > 10)
      lines.push(
        `  … and ${stats.storage.staleWorktrees.length - 10} more (beddcode gc --worktrees)`,
      )
  }
  return `${lines.join('\n')}\n`
}

/** `beddcode stats [--host h] [--json]`: what a host has been doing since it started. */
export async function statsCmd(args: string[], ctx: Ctx): Promise<number> {
  const { flags } = parseArgs(args, { bool: ['json'], string: ['host'] })
  const [target] = pickTargets(ctx.targets ?? allTargets(ctx.port), str(flags.host) ?? 'local')
  if (!target) throw new Error('No host to talk to.')
  const conn: Conn = await connect(target)
  try {
    const stats = await conn.request('host.stats', {})
    ctx.io.out(flags.json === true ? `${JSON.stringify(stats, null, 2)}\n` : formatStats(stats))
    return 0
  } finally {
    conn.close()
  }
}
