// The host for development: restarts when the server or a workspace package changes, like
// `node --watch`, but waits while an agent turn is running. An agent that edits this very code
// finishes its step first; the reload then happens between turns. Past MAX_WAIT_MS it restarts
// anyway and the interrupted turn resumes by itself on boot (see sessions/recovery.ts).
// The dev host turns the agent supervisor on by default (BEDDCODE_AGENT_SUPERVISOR=0 turns it off). With it on a
// restart cannot interrupt a turn, since the agents keep running and the new host reattaches to
// them: the reloader then restarts at once and does not wait (docs/agent-supervisor.md).
//
//   BEDDCODE_DEV_PORT          port to ask about running turns (default 3773)
//   BEDDCODE_DEV_RESTART_WAIT_FOR  "turn" (default) waits for running turns to end; "tool" only
//                              for running tool calls, so an agent can test its own change mid-turn
//   BEDDCODE_DEV_RESTART_WAIT_MS  longest wait for turns to end (default 120000; 0 = never wait)
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const roots = [path.join(dir, 'src'), path.resolve(dir, '../../packages')]
const port = process.env.BEDDCODE_DEV_PORT ?? '3773'
const DEBOUNCE_MS = 300
const POLL_MS = 1000
const WAIT_FOR =
  process.env.BEDDCODE_DEV_RESTART_WAIT_FOR === 'tool' ? 'activeTools' : 'activeTurns'
const MAX_WAIT_MS = Number(process.env.BEDDCODE_DEV_RESTART_WAIT_MS ?? 120_000)

let child
let stopping = false
let timer
let waitingSince

function start() {
  const env = { ...process.env }
  delete env.WATCH_REPORT_DEPENDENCIES
  // A dev reload must not cut off a running agent: keep agents under the supervisor so the new
  // host reattaches and the turn carries on. Opt out with BEDDCODE_AGENT_SUPERVISOR=0.
  env.BEDDCODE_AGENT_SUPERVISOR ??= '1'
  child = spawn(process.execPath, ['--import', 'tsx', 'src/main.ts', ...process.argv.slice(2)], {
    cwd: dir,
    stdio: 'inherit',
    env,
  })
  child.on('exit', (code, signal) => {
    child = undefined
    if (stopping) process.exit(code ?? 0)
    else if (signal === null && code !== 0)
      console.log(`[server] exited with ${code}, waiting for a change`)
  })
}

/** What the running host says about itself: how many turns it has, and whether agents survive a restart. */
async function hostState() {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1000),
    })
    const body = await res.json()
    return {
      turns: typeof body[WAIT_FOR] === 'number' ? body[WAIT_FOR] : 0,
      supervised: body.supervised === true,
    }
  } catch {
    return { turns: 0, supervised: false }
  }
}

async function restart() {
  if (!child) return start()
  if (MAX_WAIT_MS > 0) {
    const { turns, supervised } = await hostState()
    waitingSince ??= Date.now()
    if (supervised && turns > 0)
      console.log(
        `[server] ${turns} running ${WAIT_FOR === 'activeTools' ? 'tool call' : 'turn'}(s) continue in their agents across the restart`,
      )
    if (!supervised && turns > 0 && Date.now() - waitingSince < MAX_WAIT_MS) {
      if (Date.now() - waitingSince < POLL_MS * 2)
        console.log(
          `[server] change detected; waiting for ${turns} running ${WAIT_FOR === 'activeTools' ? 'tool call' : 'turn'}(s) to end`,
        )
      timer = setTimeout(() => void restart(), POLL_MS)
      return
    }
  }
  waitingSince = undefined
  console.log('[server] restarting')
  const old = child
  old.once('exit', () => start())
  old.kill('SIGTERM')
}

function changed(file) {
  if (!file || /node_modules|[\\/]dist[\\/]|\.(db|db-wal|db-shm|test\.ts)$|\.md$/.test(file)) return
  clearTimeout(timer)
  timer = setTimeout(() => void restart(), DEBOUNCE_MS)
}

for (const root of roots) {
  watch(root, { recursive: true }, (_event, file) => changed(file ? String(file) : ''))
}
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopping = true
    clearTimeout(timer)
    if (child) child.kill('SIGTERM')
    else process.exit(0)
  })
}
start()
