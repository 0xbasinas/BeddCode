import { parseArgs, str } from './args.ts'
import { connectAll } from './connection.ts'
import { allTargets, pickTargets } from './hosts.ts'
import { shortId } from './render.ts'
import type { Ctx } from './sessionCmds.ts'

/**
 * `beddcode previews [--host h] [--json]`: the local preview URLs the host has seen terminals
 * print (dev servers and the like), across every host this command can reach.
 */
export async function previewsCmd(args: string[], ctx: Ctx): Promise<number> {
  const { flags } = parseArgs(args, { bool: ['json'], string: ['host'] })
  const targets = pickTargets(ctx.targets ?? allTargets(ctx.port), str(flags.host))
  const { conns, failures } = await connectAll(targets)
  if (conns.length === 0) throw new Error(failures[0]?.error ?? 'No host to talk to.')
  try {
    const rows = conns.flatMap((c) =>
      c.request('previews.list', {}).then((entries) =>
        entries.map((e) => ({
          host: c.target.name,
          url: e.url,
          title: e.title ?? e.terminalId.slice(0, 8),
          cwd: e.cwd,
          session: e.sessionId ? shortId(e.sessionId) : '',
        })),
      ),
    )
    const all = (await Promise.all(rows)).flat()
    if (flags.json) {
      ctx.io.out(`${JSON.stringify(all, null, 2)}\n`)
    } else if (all.length === 0) {
      ctx.io.out(
        'No previews yet. Run a dev server in a terminal (or let an agent start one) and its localhost URL shows up here.\n',
      )
    } else {
      const width = Math.max(...all.map((r) => r.url.length))
      for (const r of all)
        ctx.io.out(
          `${r.url.padEnd(width)}  ${r.title}${r.session ? `  (session ${r.session})` : ''}  on ${r.host}\n`,
        )
      for (const f of failures) ctx.io.err(`! ${f.target.name}: ${f.error}\n`)
    }
    return 0
  } finally {
    conns.forEach((c) => c.close())
  }
}
