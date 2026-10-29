import type { HistoryItem, HistoryTurn } from '@beddcode/provider-core'
import type { runCommand } from '@beddcode/shared'

type Run = typeof runCommand

/** Ids reach the command line, so only what Grok itself generates is let through. */
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z-]{7,63}$/

const NO_SUMMARY = '(no summary)'

/**
 * One row of `grok sessions list`:
 *
 *   SESSION ID                            CREATED     UPDATED     STATUS      SUMMARY
 *   4742d025-8265-41e2-bb57-1fe5acc47e0b  2026-10-28  2026-10-28  local  List current directory
 */
export function parseSessions(stdout: string): HistoryItem[] {
  const items: HistoryItem[] = []
  for (const line of stdout.split(/\r?\n/)) {
    const m =
      /^\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s+(\d{4}-\d{2}-\d{2})\s+(\d{4}-\d{2}-\d{2})\s+\S+\s*(.*)$/i.exec(
        line,
      )
    if (!m) continue
    const summary = m[4]!.trim()
    const updated = Date.parse(`${m[3]}T00:00:00Z`)
    items.push({
      id: m[1]!,
      title: !summary || summary === NO_SUMMARY ? 'Grok session' : summary.slice(0, 120),
      ...(Number.isFinite(updated) ? { updatedAt: updated } : {}),
    })
  }
  // Newest first; the list is by day, so ties keep Grok's own order.
  return items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/** The exchanges of `grok export`, which writes `## User` and `## Assistant` sections. */
export function parseExport(markdown: string): HistoryTurn[] {
  const turns: HistoryTurn[] = []
  let role: 'user' | 'assistant' | undefined
  let buffer: string[] = []
  let user = ''
  const flush = () => {
    const text = buffer
      .join('\n')
      .replace(/\n-{3,}\s*$/, '')
      .trim()
    buffer = []
    if (role === 'user') {
      if (user) turns.push({ user, assistant: '' })
      user = text
    } else if (role === 'assistant') {
      turns.push({ user, assistant: text })
      user = ''
    }
  }
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^##\s+(User|Assistant)\s*$/.exec(line)
    if (heading) {
      flush()
      role = heading[1] === 'User' ? 'user' : 'assistant'
    } else if (role) buffer.push(line)
  }
  flush()
  if (user) turns.push({ user, assistant: '' })
  return turns
}

export function createGrokHistory(
  executable: () => string | null,
  run: Run,
  env: NodeJS.ProcessEnv,
) {
  const need = () => {
    const exe = executable()
    if (!exe) throw new Error('Grok is not installed on this host')
    return exe
  }
  return {
    /** Grok keeps its session list per folder, so it is asked from inside the folder. */
    async list(cwd?: string): Promise<HistoryItem[]> {
      const res = await run(need(), ['sessions', 'list', '--limit', '100'], {
        env,
        cwd,
        timeoutMs: 20_000,
      })
      if (res.code !== 0)
        throw new Error(
          res.stderr.trim().split(/\r?\n/).at(-1) || 'Grok could not list its sessions',
        )
      return parseSessions(res.stdout)
    },
    async read(id: string): Promise<HistoryTurn[]> {
      if (!SESSION_ID.test(id)) throw new Error('Not a Grok session id')
      const res = await run(need(), ['export', id], { env, timeoutMs: 30_000 })
      if (res.code !== 0)
        throw new Error(
          res.stderr.trim().split(/\r?\n/).at(-1) || 'Grok could not export that session',
        )
      return parseExport(res.stdout)
    },
    /** The title Grok gave a session, once it has one. */
    async title(id: string, cwd?: string): Promise<string | undefined> {
      const found = (await this.list(cwd)).find((s) => s.id === id)
      return found && found.title !== 'Grok session' ? found.title : undefined
    },
  }
}
