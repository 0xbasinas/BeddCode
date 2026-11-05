// Helpers for the supervisor tests of the providers (not part of the package's exports).
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SupervisorClient } from '../client.ts'

export const fakeAgent = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fakeAgent.mjs')

export const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const until = async (check: () => boolean, ms = 15_000) => {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

export function collect<E>(session: { events: AsyncIterable<E> }) {
  const seen: E[] = []
  void (async () => {
    for await (const e of session.events) seen.push(e)
  })()
  return seen
}

/** A scratch folder with a supervisor of its own, and what the fake agent leaves in `state`. */
export function scratch(
  flavor: 'codex' | 'acp' | 'pi',
  extra: Record<string, string> = {},
  daemonEnv: Record<string, string> = {},
) {
  const root = mkdtempSync(path.join(tmpdir(), 'bc-sup-'))
  const state = path.join(root, 'state')
  mkdirSync(state)
  const env = {
    ...process.env,
    FAKE_FLAVOR: flavor,
    FAKE_STATE: state,
    FAKE_PARTS: '8',
    FAKE_TICK_MS: '250',
    ...extra,
  }
  // A new client each time is a new host: nothing but the folder is shared.
  const host = () =>
    new SupervisorClient(path.join(root, 'supervisor'), {
      daemonEnv: { BEDDCODE_SUPERVISOR_IDLE_MS: '500', ...daemonEnv },
    })
  const spec = { command: process.execPath, args: [fakeAgent], env, cwd: root }
  return {
    root,
    env,
    spec,
    host,
    pid: () => Number(readFileSync(path.join(state, 'pid'), 'utf8')),
    starts: () => readFileSync(path.join(state, 'starts'), 'utf8'),
    received: () => readFileSync(path.join(state, 'received'), 'utf8').split('\n').filter(Boolean),
    async cleanup() {
      for (const a of await host().list()) if (alive(a.pid)) process.kill(a.pid)
      await new Promise((r) => setTimeout(r, 1_200)) // the daemon leaves once it holds nothing
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
      } catch {
        // a log file the daemon still has open (Windows); it is a temp folder
      }
    },
  }
}
