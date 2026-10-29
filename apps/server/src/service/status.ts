import { fetchHealth, type HostHealth } from '../cli/health.ts'
import { SERVICE_NAME, serviceInstalled, WINDOWS_TASK } from './install.ts'

export interface HostStatusDeps {
  platform: NodeJS.Platform
  installed(): Promise<boolean>
  health(port: number): Promise<HostHealth | null>
  out(line: string): void
}

/**
 * `beddcode host status`: is the background host installed, and does a host answer on the port?
 * Exit 0 when one answers, 3 when it is installed but not answering, 1 when neither (as in scripts).
 */
export async function hostStatus(
  port: number,
  deps: HostStatusDeps = {
    platform: process.platform,
    installed: () => serviceInstalled(),
    health: (p) => fetchHealth(p),
    out: (line) => console.log(line),
  },
): Promise<number> {
  const [installed, health] = await Promise.all([deps.installed(), deps.health(port)])
  const where =
    deps.platform === 'win32' ? `scheduled task "${WINDOWS_TASK}"` : `user service ${SERVICE_NAME}`
  deps.out(
    installed
      ? `Background host: installed (${where})`
      : 'Background host: not installed (`beddcode host install` sets it up)',
  )
  deps.out(
    health
      ? `Host: ${health.name} answers on port ${port} (${health.version})`
      : `Host: nothing answers on port ${port}`,
  )
  if (health) return 0
  if (installed) {
    deps.out(
      deps.platform === 'win32'
        ? `Start it with: schtasks /Run /TN "${WINDOWS_TASK}"   (its log: beddcode logs)`
        : `Start it with: systemctl --user start ${SERVICE_NAME}   (its log: journalctl --user -u ${SERVICE_NAME})`,
    )
    return 3
  }
  return 1
}
