import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'apps/server/package.json'))
const home = mkdtempSync(path.join(os.tmpdir(), 'beddcode-e2e-'))
const port = Number(process.argv[2])
const realAgents = process.argv[3] === '--real-agents'
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected a port')

// The isolated host has its own agent catalog; register Grok without copying user settings.
if (realAgents) {
  writeFileSync(
    path.join(home, 'acp-agents.json'),
    JSON.stringify({
      version: 1,
      agents: [{ id: 'grok', label: 'Grok', command: 'grok', args: ['agent', 'stdio'], env: {} }],
    }),
  )
}

const child = spawn(
  process.execPath,
  [
    '--import',
    pathToFileURL(require.resolve('tsx')).href,
    path.join(root, 'apps/server/src/main.ts'),
    'serve',
  ],
  {
    cwd: home,
    stdio: 'inherit',
    env: {
      ...process.env,
      BEDDCODE_HOME: home,
      BEDDCODE_PORT: String(port),
      BEDDCODE_HOST: '127.0.0.1',
      BEDDCODE_FAKE_PROVIDER: realAgents ? '0' : 'advanced',
      BEDDCODE_WEB_ROOT: path.join(root, 'apps/web/dist'),
      BEDDCODE_TELEMETRY: '0',
    },
  },
)
const pidFile = path.join(root, '.e2e', `host-${port}.json`)
mkdirSync(path.dirname(pidFile), { recursive: true })
writeFileSync(pidFile, JSON.stringify({ pid: child.pid }))

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  child.kill()
}
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
child.on('error', (error) => {
  console.error(error)
  rmSync(home, { recursive: true, force: true })
  rmSync(pidFile, { force: true })
  process.exitCode = 1
})
child.on('exit', (code, signal) => {
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  rmSync(pidFile, { force: true })
  process.exitCode = stopping ? 0 : (code ?? (signal ? 1 : 0))
})
