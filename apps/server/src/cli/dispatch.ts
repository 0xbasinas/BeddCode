import { existsSync } from 'node:fs'
import { resolveExecutable, runCommand } from '@beddcode/shared'
import { dataHome } from '../hostIdentity.ts'
import { TailscaleService } from '../network/tailscale.ts'
import { doctor, doctorExitCode, formatChecks } from './doctor.ts'
import { fetchHealth } from './health.ts'
import { hostsCmd } from './hostsCmd.ts'
import { realIo, type Io } from './io.ts'
import { hostLogPath, logs } from './logs.ts'
import { openApp } from './open.ts'
import { pair } from './pair.ts'
import { parseArgs, num } from './args.ts'
import {
  approveCmd,
  attachCmd,
  lsCmd,
  runCmd,
  sendCmd,
  stopCmd,
  undoCmd,
  type Ctx,
} from './sessionCmds.ts'
import { status } from './status.ts'

export type Handler = (args: string[], ctx: Ctx) => Promise<number>

function logsCmd(args: string[]): Promise<number> {
  const { flags } = parseArgs(args, {
    bool: ['follow'],
    string: ['lines'],
    alias: { f: 'follow', n: 'lines' },
  })
  const lines = num(flags.lines, 'lines') ?? 50
  if (!Number.isInteger(lines) || lines < 1) throw new Error('--lines needs a number of lines')
  return Promise.resolve(logs(hostLogPath(), { lines, follow: flags.follow === true }))
}

async function doctorCmd(_args: string[], ctx: Ctx): Promise<number> {
  const checks = await doctor({
    port: ctx.port,
    health: fetchHealth,
    find: (name) => resolveExecutable(name),
    run: (file, a) => runCommand(file, a, { timeoutMs: 8000 }),
    tailnet: () => new TailscaleService().status(),
    dataDir: dataHome(),
    dirExists: existsSync,
  })
  ctx.io.out(`${formatChecks(checks)}\n`)
  return doctorExitCode(checks)
}

/** The commands that talk to a host or to this machine, by name. */
export const HANDLERS: Record<string, Handler> = {
  status: (_a, ctx) => status(ctx.port),
  pair: (_a, ctx) => pair(ctx.port),
  open: () => Promise.resolve(openApp()),
  logs: (a) => logsCmd(a),
  doctor: doctorCmd,
  ls: lsCmd,
  run: (a, ctx) => runCmd(a, ctx),
  send: (a, ctx) => sendCmd(a, ctx),
  stop: stopCmd,
  approve: approveCmd,
  undo: undoCmd,
  attach: attachCmd,
  hosts: (a, ctx) => hostsCmd(a, ctx.io),
}

/** Takes `--port <n>` out of the arguments, wherever it is. */
export function takePort(args: string[], fallback: number): { port: number; rest: string[] } {
  const rest: string[] = []
  let port = fallback
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--port') {
      port = Number(args[++i])
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length))
    } else rest.push(arg)
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid port: ${port}`)
  return { port, rest }
}

export async function runHandler(
  command: string,
  args: string[],
  fallbackPort: number,
  io: Io = realIo(),
): Promise<number> {
  const handler = HANDLERS[command]
  if (!handler) throw new Error(`Unknown command: ${command}`)
  const { port, rest } = takePort(args, fallbackPort)
  try {
    return await handler(rest, { port, io })
  } finally {
    io.close?.()
  }
}
