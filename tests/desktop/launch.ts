import { mkdtempSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'

export const root = path.resolve(import.meta.dirname, '../..')

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })

export interface DesktopEnv {
  home: string
  userData: string
  port: number
}

/** Fresh temporary folders and a free port; the app never touches an installed BeddCode. */
export async function desktopEnv(realAgents = false): Promise<DesktopEnv> {
  const home = mkdtempSync(path.join(os.tmpdir(), 'beddcode-desktop-home-'))
  const userData = mkdtempSync(path.join(os.tmpdir(), 'beddcode-desktop-data-'))
  if (realAgents) {
    // The isolated host has its own agent catalog; register Grok without copying user settings.
    writeFileSync(
      path.join(home, 'acp-agents.json'),
      JSON.stringify({
        version: 1,
        agents: [{ id: 'grok', label: 'Grok', command: 'grok', args: ['agent', 'stdio'], env: {} }],
      }),
    )
  }
  return { home, userData, port: await freePort() }
}

/** Starts the real desktop app on its own host; the fake agent unless `realAgents`. */
export async function launchDesktop(
  env: DesktopEnv,
  realAgents = false,
  extraEnv: Record<string, string> = {},
): Promise<{ app: ElectronApplication; page: Page; startedAt: number }> {
  const startedAt = performance.now()
  const base = { ...process.env } as Record<string, string>
  delete base.ELECTRON_RUN_AS_NODE
  const app = await electron.launch({
    args: [path.join(root, 'apps/desktop'), `--user-data-dir=${env.userData}`],
    cwd: root,
    env: {
      ...base,
      BEDDCODE_HOME: env.home,
      BEDDCODE_PORT: String(env.port),
      BEDDCODE_HOST: '127.0.0.1',
      BEDDCODE_FAKE_PROVIDER: realAgents ? '0' : 'advanced',
      BEDDCODE_WEB_ROOT: path.join(root, 'apps/web/dist'),
      BEDDCODE_TELEMETRY: '0',
      ...extraEnv,
    },
  })
  return { app, page: await app.firstWindow(), startedAt }
}
