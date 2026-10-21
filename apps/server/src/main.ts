import os from 'node:os'
import type { PairingCode } from '@beddcode/contracts'
import { parseServeArgs } from './config.ts'
import { TailscaleService } from './network/tailscale.ts'
import { runServer } from './runServer.ts'
import { installService, uninstallService } from './service/install.ts'

const USAGE = `BeddCode host

Usage: beddcode-server [command] [options]

Commands:
  serve               Run the host (default)
  pair                Print a one-time code to pair another device with this host
  install-service     Run the host in the background, starting at login
  uninstall-service   Stop it and remove it

Options for serve and install-service:
  --host <address>    Address to listen on (default 127.0.0.1; use 0.0.0.0 for other machines)
  --port <number>     Port (default 3773)
  --allow-lan         Also accept machines on your local network, not just the tailnet
  --require-token     Ask for a paired device's token even from this machine
  --allow-origin <o>  Let a web page at this origin connect (repeatable)

Other: --dry-run      With (un)install-service, show what would happen and change nothing
`

/** Pairing happens on the machine itself, through the running host. */
async function pair(port: number) {
  let code: PairingCode
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/pair`, { method: 'POST' })
    if (!res.ok) throw new Error(`the host answered ${res.status}`)
    code = (await res.json()) as PairingCode
  } catch (err) {
    console.error(
      `Could not reach the host on port ${port} (${err instanceof Error ? err.message : err}). Is it running?`,
    )
    process.exitCode = 1
    return
  }

  const status = await new TailscaleService().status()
  const addresses = [
    status.self && `${status.self.dnsName || status.self.name} (${status.self.ip})`,
    ...Object.values(os.networkInterfaces())
      .flat()
      .filter((i) => i && i.family === 'IPv4' && !i.internal && !i.address.startsWith('169.254.'))
      .map((i) => i!.address),
  ].filter(Boolean)
  const minutes = Math.round((code.expiresAt - Date.now()) / 60_000)
  console.log(`Pairing code: ${code.code}   (valid for ${minutes} minutes, works once)`)
  console.log(`Add this host in BeddCode with one of these addresses on port ${port}:`)
  addresses.forEach((a) => console.log(`  ${a}`))
}

const [first = 'serve', ...rest] = process.argv.slice(2)
const wantsHelp = first === '--help' || first === '-h' || first === 'help'
const known = ['serve', 'pair', 'install-service', 'uninstall-service']
const command = known.includes(first)
  ? first
  : first.startsWith('-') && !wantsHelp
    ? 'serve'
    : first
const args = command === first ? rest : [first, ...rest]
const dryRun = args.includes('--dry-run')
const serveArgs = args.filter((a) => a !== '--dry-run')

try {
  if (wantsHelp || !known.includes(command)) {
    console.log(USAGE)
    process.exitCode = wantsHelp ? 0 : 1
  } else if (command === 'pair') {
    await pair(parseServeArgs(serveArgs).port)
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
