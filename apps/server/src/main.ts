import { existsSync } from 'node:fs'
import { resolveExecutable, runCommand } from '@beddcode/shared'
import { parseServeArgs } from './config.ts'
import { doctor, doctorExitCode, formatChecks } from './cli/doctor.ts'
import { fetchHealth } from './cli/health.ts'
import { hostLogPath, logs } from './cli/logs.ts'
import { openApp } from './cli/open.ts'
import { pair } from './cli/pair.ts'
import { status } from './cli/status.ts'
import { dataHome } from './hostIdentity.ts'
import { TailscaleService } from './network/tailscale.ts'
import { runServer } from './runServer.ts'
import { installService, uninstallService } from './service/install.ts'

// `node --watch` (the dev script) makes every worker thread report the files it loads. The terminal
// library keeps one worker per shell and takes any message from it for its own, which crashes the
// host when a terminal closes. Workers copy this variable when they start, so clearing it here,
// before a terminal can exist, leaves them quiet. Watch mode itself is unaffected.
delete process.env.WATCH_REPORT_DEPENDENCIES

const USAGE = `BeddCode

Usage: beddcode <command> [options]

Commands:
  status              Is the host on this machine running?
  open                Start the BeddCode desktop app
  pair                Print a one-time code to pair another device with this host
  logs                Show the host's log (-n <lines>, -f to follow)
  doctor              Check git, agent CLIs, GitHub, Tailscale and the host, and say how to fix them
  serve               Run the host in this terminal
  install-service     Run the host in the background, starting at login
  uninstall-service   Stop it and remove it

Options for status, pair, doctor, serve and install-service:
  --port <number>     Port (default 3773)

Options for serve and install-service:
  --host <address>    Address to listen on (default 127.0.0.1; use 0.0.0.0 for other machines)
  --allow-lan         Also accept machines on your local network, not just the tailnet
  --require-token     Ask for a paired device's token even from this machine
  --allow-origin <o>  Let a web page at this origin connect (repeatable)

Other: --dry-run      With (un)install-service, show what would happen and change nothing
`

const COMMANDS = [
  'serve',
  'pair',
  'status',
  'open',
  'logs',
  'doctor',
  'install-service',
  'uninstall-service',
]

/** The port from `--port`, or the default; the other commands take no other options. */
const portOf = (args: string[]) => parseServeArgs(args).port

function logOptions(args: string[]) {
  let lines = 50
  let follow = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '-f' || arg === '--follow') follow = true
    else if (arg === '-n' || arg === '--lines') {
      lines = Number(args[++i])
      if (!Number.isInteger(lines) || lines < 1) throw new Error(`${arg} needs a number of lines`)
    } else throw new Error(`Unknown option: ${arg}`)
  }
  return { lines, follow }
}

// A bare `beddcode` is help when run as the installed command (its launcher sets BEDDCODE_APP), and
// the host when started by the app itself or from a checkout, which pass options or nothing.
const [first = process.env.BEDDCODE_APP ? 'help' : 'serve', ...rest] = process.argv.slice(2)
const wantsHelp = first === '--help' || first === '-h' || first === 'help'
const command = COMMANDS.includes(first)
  ? first
  : first.startsWith('-') && !wantsHelp
    ? 'serve'
    : first
const args = command === first ? rest : [first, ...rest]
const dryRun = args.includes('--dry-run')
const serveArgs = args.filter((a) => a !== '--dry-run')

try {
  if (wantsHelp || !COMMANDS.includes(command)) {
    console.log(USAGE)
    process.exitCode = wantsHelp ? 0 : 1
  } else if (command === 'pair') {
    process.exitCode = await pair(portOf(serveArgs))
  } else if (command === 'status') {
    process.exitCode = await status(portOf(serveArgs))
  } else if (command === 'open') {
    process.exitCode = openApp()
  } else if (command === 'logs') {
    process.exitCode = logs(hostLogPath(), logOptions(args))
  } else if (command === 'doctor') {
    const checks = await doctor({
      port: portOf(serveArgs),
      health: fetchHealth,
      find: (name) => resolveExecutable(name),
      run: (file, a) => runCommand(file, a, { timeoutMs: 8000 }),
      tailnet: () => new TailscaleService().status(),
      dataDir: dataHome(),
      dirExists: existsSync,
    })
    console.log(formatChecks(checks))
    process.exitCode = doctorExitCode(checks)
  } else if (command === 'install-service') {
    parseServeArgs(serveArgs) // fail now on a typo rather than in the background
    // A background host exists to be reached from other machines, so it listens beyond loopback
    // unless told otherwise. Only the tailnet and paired devices get in (see auth/guard.ts).
    const withHost = serveArgs.includes('--host') ? serveArgs : ['--host', '0.0.0.0', ...serveArgs]
    await installService({ serveArgs: withHost, dryRun })
  } else if (command === 'uninstall-service') {
    await uninstallService({ dryRun })
  } else {
    await runServer(parseServeArgs(serveArgs))
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
}
