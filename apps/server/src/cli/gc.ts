import type { GcReport } from '@beddcode/contracts'
import { parseArgs, num, str } from './args.ts'
import { connect } from './connection.ts'
import { allTargets, pickTargets } from './hosts.ts'
import { age, shortId } from './render.ts'
import type { Ctx } from './sessionCmds.ts'

const fmtBytes = (n: number) => {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`
}

/** The report as lines: what went (or would go), and what the log weighs now. */
export function formatGcReport(report: GcReport, now = Date.now()): string {
  const lines: string[] = []
  lines.push(
    `${report.dryRun ? 'Would remove' : 'Removed'} sessions quiet for over ${Math.round((now - report.cutoff) / 86_400_000)}d:`,
  )
  const removed = report.sessions.filter((s) => s.removed)
  if (removed.length === 0) lines.push('  (none)')
  for (const s of removed.slice(0, 20)) {
    lines.push(
      `  ${shortId(s.id)}  ${s.title || '(untitled)'}  quiet ${age(s.lastActiveAt, now)}${s.worktree ? '  [worktree]' : ''}${s.note ? `  — ${s.note}` : ''}`,
    )
  }
  if (removed.length > 20) lines.push(`  … and ${removed.length - 20} more`)
  lines.push(
    `sessions ${report.sessionsRemoved}, worktrees ${report.worktreesRemoved}, attachments ${report.attachmentsRemoved} (${fmtBytes(report.attachmentBytesFreed)})`,
  )
  if (report.vacuumed)
    lines.push(
      `log vacuumed: ${fmtBytes(report.dbBytesBefore)} -> ${fmtBytes(report.dbBytesAfter)} (freed ${fmtBytes(Math.max(0, report.dbBytesBefore - report.dbBytesAfter))})`,
    )
  else
    lines.push(
      `log: ${fmtBytes(report.dbBytesAfter)} (not vacuumed${report.dryRun ? ', dry run' : ''})`,
    )
  return `${lines.join('\n')}\n`
}

/**
 * `beddcode gc [--host h] [--days N] [--dry-run] [--worktrees] [--no-vacuum] [--yes] [--json]`:
 * housekeeping on a host — remove sessions that have been quiet for N days (default 30), their
 * worktrees when clean, attachments nothing references, and vacuum the log. A dry run first shows
 * what would happen; the real run asks unless `--yes`.
 */
export async function gcCmd(args: string[], ctx: Ctx): Promise<number> {
  const { flags } = parseArgs(args, {
    bool: ['dry-run', 'worktrees', 'no-vacuum', 'yes', 'json'],
    string: ['host', 'days'],
  })
  const days = num(flags.days, 'days') ?? 30
  if (!Number.isInteger(days) || days < 1 || days > 3650)
    throw new Error(
      '--days is 1 to 3650 (0 is not allowed; unset retention-days to keep everything)',
    )
  const [target] = pickTargets(ctx.targets ?? allTargets(ctx.port), str(flags.host) ?? 'local')
  if (!target) throw new Error('No host to talk to.')
  const conn = await connect(target)
  try {
    const base = {
      days,
      worktrees: flags.worktrees === true,
      vacuum: flags['no-vacuum'] !== true,
    }
    if (flags['dry-run'] === true) {
      const report = await conn.request('host.gc', { ...base, dryRun: true })
      if (flags.json === true) ctx.io.out(`${JSON.stringify(report, null, 2)}\n`)
      else ctx.io.out(formatGcReport(report))
      return 0
    }
    // Show what is about to happen, then ask.
    const preview = await conn.request('host.gc', { ...base, dryRun: true })
    const candidates = preview.sessions.filter((s) => s.removed)
    if (candidates.length === 0) {
      ctx.io.err('Nothing to remove: no session has been quiet that long.\n')
      return 0
    }
    if (flags.json !== true) ctx.io.err(formatGcReport(preview))
    if (flags.yes !== true) {
      if (!ctx.io.interactive)
        throw new Error(
          `${candidates.length} session(s) would be removed. Add --yes to confirm, or --dry-run to just look.`,
        )
      const answer = (
        await ctx.io.ask(`Remove ${candidates.length} session(s)? [y/N] `)
      ).toLowerCase()
      if (answer !== 'y' && answer !== 'yes') {
        ctx.io.err('Kept.\n')
        return 1
      }
    }
    const report = await conn.request('host.gc', base)
    if (flags.json === true) ctx.io.out(`${JSON.stringify(report, null, 2)}\n`)
    else ctx.io.out(formatGcReport(report))
    return 0
  } finally {
    conn.close()
  }
}
