import { parseServeArgs } from './config.ts'
import { HANDLERS, runHandler } from './cli/dispatch.ts'
import { USAGE } from './cli/usage.ts'
import { runServer } from './runServer.ts'
import { installService, uninstallService } from './service/install.ts'

// `node --watch` (the dev script) makes every worker thread report the files it loads. The terminal
// library keeps one worker per shell and takes any message from it for its own, which crashes the
// host when a terminal closes. Workers copy this variable when they start, so clearing it here,
// before a terminal can exist, leaves them quiet. Watch mode itself is unaffected.
delete process.env.WATCH_REPORT_DEPENDENCIES

// Commands that run or install the host itself; everything else is a client of a running host.
const HOST_COMMANDS = ['serve', 'install-service', 'uninstall-service', 'host']
const COMMANDS = [...HOST_COMMANDS, ...Object.keys(HANDLERS)]

// A bare `beddcode` is help when run as the installed command (its launcher sets BEDDCODE_APP), and
// the host when started by the app itself or from a checkout, which pass options or nothing.
const [first = process.env.BEDDCODE_APP ? 'help' : 'serve', ...rest] = process.argv.slice(2)
const wantsHelp = first === '--help' || first === '-h' || first === 'help'
const command = COMMANDS.includes(first)
  ? first
  : first.startsWith('-') && !wantsHelp
    ? 'serve'
    : first
let args = command === first ? rest : [first, ...rest]
// `beddcode host install|uninstall` is the headless way to say install-service.
let hostAction: 'install-service' | 'uninstall-service' | null = null
if (command === 'host') {
  const [action, ...more] = args
  if (action !== 'install' && action !== 'uninstall') {
    console.error('Usage: beddcode host install|uninstall [--port n] [--host address] [--dry-run]')
    process.exit(1)
  }
  hostAction = action === 'install' ? 'install-service' : 'uninstall-service'
  args = more
}
const dryRun = args.includes('--dry-run')
const serveArgs = args.filter((a) => a !== '--dry-run')

try {
  if (wantsHelp || !COMMANDS.includes(command)) {
    console.log(USAGE)
    process.exitCode = wantsHelp ? 0 : 1
  } else if (command === 'install-service' || hostAction === 'install-service') {
    parseServeArgs(serveArgs) // fail now on a typo rather than in the background
    // A background host exists to be reached from other machines, so it listens beyond loopback
    // unless told otherwise. Only the tailnet and paired devices get in (see auth/guard.ts).
    const withHost = serveArgs.includes('--host') ? serveArgs : ['--host', '0.0.0.0', ...serveArgs]
    await installService({ serveArgs: withHost, dryRun })
    if (hostAction && !dryRun) {
      console.log('Installed. Pair a device with: beddcode pair')
    }
  } else if (command === 'uninstall-service' || hostAction === 'uninstall-service') {
    await uninstallService({ dryRun })
  } else if (command === 'serve') {
    await runServer(parseServeArgs(serveArgs))
  } else {
    process.exitCode = await runHandler(command, args, parseServeArgs([]).port)
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err)
  process.exitCode = 1
}
