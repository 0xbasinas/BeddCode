import os from 'node:os'
import type { PairingCode } from '@beddcode/contracts'
import { TailscaleService } from '../network/tailscale.ts'

/** Pairing happens on the machine itself, through the running host. */
export async function pair(port: number): Promise<number> {
  let code: PairingCode
  try {
    const res = await fetch(`http://127.0.0.1:${port}/admin/pair`, { method: 'POST' })
    if (!res.ok) throw new Error(`the host answered ${res.status}`)
    code = (await res.json()) as PairingCode
  } catch (err) {
    console.error(
      `Could not reach the host on port ${port} (${err instanceof Error ? err.message : err}). Is it running?`,
    )
    return 1
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
  return 0
}
