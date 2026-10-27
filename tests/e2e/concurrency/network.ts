import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

const run = promisify(execFile)
export type NetworkCounter = {
  id: string
  name: string
  type: string
  receivedBytes: number
  sentBytes: number
}
export type NetworkSnapshot = { at: string; interfaces: NetworkCounter[]; error?: string }

/** OS adapter counters cover all machine traffic; virtual and physical adapters may overlap. */
export async function networkSnapshot(): Promise<NetworkSnapshot> {
  try {
    if (process.platform === 'win32') {
      const script = `[System.Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces() | Where-Object { $_.OperationalStatus -eq 'Up' -and $_.NetworkInterfaceType -ne 'Loopback' -and $_.Name -notmatch 'LightWeight Filter|Packet Scheduler' } | ForEach-Object { $s = $_.GetIPv4Statistics(); [pscustomobject]@{id=$_.Id;name=$_.Name;type=$_.NetworkInterfaceType.ToString();receivedBytes=$s.BytesReceived;sentBytes=$s.BytesSent} } | ConvertTo-Json -Compress`
      const { stdout } = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', script],
        { timeout: 5000, windowsHide: true },
      )
      const parsed = stdout.trim() ? JSON.parse(stdout) : []
      return { at: new Date().toISOString(), interfaces: Array.isArray(parsed) ? parsed : [parsed] }
    }
    if (process.platform === 'linux') {
      const content = await readFile('/proc/net/dev', 'utf8')
      const interfaces = content
        .split('\n')
        .slice(2)
        .flatMap((line) => {
          const match = /^\s*([^:]+):\s*(.*)$/.exec(line)
          if (!match || match[1]!.trim() === 'lo') return []
          const name = match[1]!.trim()
          const values = match[2]!.trim().split(/\s+/).map(Number)
          return values.length >= 16 && Number.isFinite(values[0]) && Number.isFinite(values[8])
            ? [
                {
                  id: name,
                  name,
                  type: 'unknown',
                  receivedBytes: values[0]!,
                  sentBytes: values[8]!,
                },
              ]
            : []
        })
      return { at: new Date().toISOString(), interfaces }
    }
    return {
      at: new Date().toISOString(),
      interfaces: [],
      error: 'Network counters are not supported on this platform',
    }
  } catch (error) {
    return {
      at: new Date().toISOString(),
      interfaces: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

export function networkDelta(before: NetworkSnapshot, after: NetworkSnapshot) {
  const seconds = (Date.parse(after.at) - Date.parse(before.at)) / 1000
  return {
    startedAt: before.at,
    finishedAt: after.at,
    seconds,
    error: before.error ?? after.error,
    interfaces: after.interfaces.flatMap((current) => {
      const previous = before.interfaces.find((item) => item.id === current.id)
      if (!previous) return []
      const receivedBytes = current.receivedBytes - previous.receivedBytes
      const sentBytes = current.sentBytes - previous.sentBytes
      if (receivedBytes < 0 || sentBytes < 0) return []
      return [
        {
          name: current.name,
          type: current.type,
          receivedBytes,
          sentBytes,
          averageReceiveBytesPerSecond: seconds > 0 ? receivedBytes / seconds : null,
          averageSendBytesPerSecond: seconds > 0 ? sentBytes / seconds : null,
        },
      ]
    }),
  }
}
