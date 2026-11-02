// The desktop app for development: rebuilds the main and preload bundles whenever their sources
// change and restarts Electron with the new code. The window itself loads the web app from the Vite
// dev server, which hot-reloads on its own, so only main-process changes need a restart.
//
//   node apps/desktop/scripts/dev.mjs          (run by `pnpm dev`, after the host and Vite are up)
//
// Same bundles as `pnpm bundle`; keep the two in step when an entry point is added.
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { context } from 'esbuild'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const electron = createRequire(import.meta.url)('electron')
const webUrl = process.env.BEDDCODE_WEB_URL ?? 'http://localhost:5173'
// Saving several files at once, or an editor writing twice, restarts once.
const RESTART_DELAY_MS = 250

const node = { platform: 'node', format: 'cjs', external: ['electron'], bundle: true }
const entries = [
  {
    ...node,
    entryPoints: [path.join(dir, 'src/main.ts')],
    outfile: path.join(dir, 'dist/main.cjs'),
  },
  {
    ...node,
    entryPoints: [path.join(dir, 'src/preload.ts')],
    outfile: path.join(dir, 'dist/preload.cjs'),
  },
  {
    ...node,
    platform: 'browser',
    entryPoints: [path.join(dir, '../../packages/electron-chrome-extensions/src/preload.ts')],
    outfile: path.join(dir, 'dist/chrome-extension-api.preload.cjs'),
  },
]

let child
let restarting = false
let timer
let shuttingDown = false

function launch() {
  child = spawn(electron, ['.'], {
    cwd: dir,
    stdio: 'inherit',
    env: { ...process.env, BEDDCODE_WEB_URL: webUrl },
  })
  child.on('exit', (code) => {
    child = undefined
    if (restarting) {
      restarting = false
      launch()
    } else if (!shuttingDown) {
      // The window was closed: end the dev session like running `electron .` directly would.
      void shutdown(code ?? 0)
    }
  })
}

function restart() {
  clearTimeout(timer)
  timer = setTimeout(() => {
    if (!child) return launch()
    console.log('[desktop] main process changed, restarting')
    restarting = true
    child.kill()
  }, RESTART_DELAY_MS)
}

let waiting = entries.length
const contexts = await Promise.all(
  entries.map((options) => {
    let first = true
    return context({
      ...options,
      logLevel: 'warning',
      plugins: [
        {
          name: 'restart-electron',
          setup(build) {
            build.onEnd((result) => {
              // A build with errors keeps the running app; fix it and save again.
              if (result.errors.length > 0) return
              if (first) {
                first = false
                if (--waiting === 0) launch()
              } else restart()
            })
          },
        },
      ],
    })
  }),
)

async function shutdown(code) {
  shuttingDown = true
  clearTimeout(timer)
  child?.kill()
  await Promise.all(contexts.map((c) => c.dispose().catch(() => {})))
  process.exit(code)
}
process.on('SIGINT', () => void shutdown(0))
process.on('SIGTERM', () => void shutdown(0))

// BEDDCODE_DEV_WATCH=0 builds once and never restarts: the same as running `pnpm bundle` then
// `electron .`. Use it to rule the watcher out, or for a quiet machine while profiling.
if (process.env.BEDDCODE_DEV_WATCH === '0') {
  await Promise.all(contexts.map((c) => c.rebuild()))
  await Promise.all(contexts.map((c) => c.dispose()))
  console.log('[desktop] built once (BEDDCODE_DEV_WATCH=0); main-process changes need a restart')
} else {
  await Promise.all(contexts.map((c) => c.watch()))
  console.log('[desktop] watching main and preload; the window hot-reloads through Vite')
}
