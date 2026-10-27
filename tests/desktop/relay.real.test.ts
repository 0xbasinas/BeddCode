import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ElectronApplication } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { desktopEnv, launchDesktop, root, type DesktopEnv } from './launch.ts'

// A long, scripted relay between three real agents: one orchestrator drives a builder, a reviewer
// and a tester through five rounds of "add a function, review it, fix it, run it": about twenty
// helper turns in one repo. A test we keep hidden until the end checks the result, and the report
// lists every turn, approval, tool error and silence so a trip-up can be placed. Pick the
// orchestrator with DESKTOP_RELAY_PARENT (claude, codex or grok; default claude).
const agents = {
  claude: { id: 'claude', label: 'Claude', mode: 'default' },
  codex: { id: 'codex', label: 'Codex', mode: 'auto' },
  grok: { id: 'acp:grok', label: 'Grok', mode: 'ask' },
} as const
type Name = keyof typeof agents
const parent = (process.env.DESKTOP_RELAY_PARENT ?? 'claude') as Name
const [builder, reviewer] = (Object.keys(agents) as Name[]).filter((n) => n !== parent)

const FUNCTIONS = ['mean', 'median', 'mode', 'variance', 'percentile'] as const

const README = `# stats

A small dependency-free library in \`src/stats.js\` (CommonJS, \`module.exports\`). Tests use
\`node:test\` and live in \`test/\`, one file per function; run them with \`node --test\`.

All functions take an array of numbers and throw \`RangeError\` for an empty array.

- \`mean(xs)\`: the average.
- \`median(xs)\`: the middle value; for an even count, the average of the two middle values.
- \`mode(xs)\`: the sorted array of the most frequent values (ties are all returned).
- \`variance(xs)\`: the population variance.
- \`percentile(xs, p)\`: nearest-rank percentile, \`p\` from 1 to 100 (else \`RangeError\`).
  Rank = ceil(p / 100 * n), 1-based, over the sorted values.

Do not mutate the input array.
`

// Kept out of the repo until the agents are done, so nobody can read or fit to it.
const ACCEPTANCE = `
const test = require('node:test')
const assert = require('node:assert')
const s = require('./src/stats.js')
const frozen = (xs) => Object.freeze([...xs])
test('mean', () => {
  assert.strictEqual(s.mean(frozen([1, 2, 3, 4])), 2.5)
  assert.throws(() => s.mean([]), RangeError)
})
test('median', () => {
  assert.strictEqual(s.median(frozen([5, 1, 3])), 3)
  assert.strictEqual(s.median(frozen([4, 1, 3, 2])), 2.5)
  assert.throws(() => s.median([]), RangeError)
})
test('mode', () => {
  assert.deepStrictEqual(s.mode(frozen([1, 2, 2, 3])), [2])
  assert.deepStrictEqual(s.mode(frozen([3, 1, 3, 1, 2])), [1, 3])
  assert.throws(() => s.mode([]), RangeError)
})
test('variance', () => {
  assert.strictEqual(s.variance(frozen([2, 4, 4, 4, 5, 5, 7, 9])), 4)
  assert.throws(() => s.variance([]), RangeError)
})
test('percentile', () => {
  const xs = frozen([15, 20, 35, 40, 50])
  assert.strictEqual(s.percentile(xs, 30), 20)
  assert.strictEqual(s.percentile(xs, 40), 20)
  assert.strictEqual(s.percentile(xs, 100), 50)
  assert.strictEqual(s.percentile(xs, 1), 15)
  assert.throws(() => s.percentile(xs, 0), RangeError)
  assert.throws(() => s.percentile(xs, 101), RangeError)
  assert.throws(() => s.percentile([], 50), RangeError)
})
`

let env: DesktopEnv
let app: ElectronApplication
let host: Host
let approving = true
let repo = ''
const report: Record<string, any> = { startedAt: new Date().toISOString() }

const created = (id: string) =>
  host.events.find(({ event }) => event.type === 'session.created' && event.sessionId === id)?.event
const of = (id: string) => host.events.filter(({ event }) => event.sessionId === id)
const text = (id: string) =>
  of(id)
    .filter(({ event }) => event.type === 'message.delta' && event.role === 'assistant')
    .map(({ event }) => event.text)
    .join('')
const ended = (id: string) => of(id).findLast(({ event }) => event.type === 'turn.completed')?.event
const childrenOf = (id: string) =>
  host.events
    .filter(({ event }) => event.type === 'session.created' && event.parent?.sessionId === id)
    .map(({ event }) => event.sessionId as string)

beforeAll(async () => {
  env = await desktopEnv(true)
  const launched = await launchDesktop(env, true)
  app = launched.app
  await launched.page
    .getByRole('heading', { name: 'Welcome to BeddCode' })
    .waitFor({ timeout: 90_000 })
  await launched.page.getByRole('button', { name: 'Skip setup' }).click()
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
  // Everyone's approvals are answered; what is measured is the relay, not the permission prompts.
  const answered = new Set<string>()
  void (async () => {
    while (approving) {
      for (const { event } of host.events) {
        if (event.type !== 'approval.requested') continue
        const key = `${event.sessionId}:${event.requestId}`
        if (answered.has(key)) continue
        answered.add(key)
        const allow = event.options.find((o: any) => o.kind === 'allow')
        if (allow)
          await host
            .rpc('sessions.approve', {
              sessionId: event.sessionId,
              requestId: event.requestId,
              optionId: allow.id,
            })
            .catch(() => {})
      }
      await new Promise((r) => setTimeout(r, 300))
    }
  })()
})

afterAll(async () => {
  approving = false
  host?.close()
  await app?.close().catch(() => {})
  const dir = path.join(root, '.e2e', 'desktop-stats')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    path.join(dir, `relay-${parent}-${Date.now()}.json`),
    JSON.stringify(report, null, 2),
  )
  for (const folder of [env?.home, env?.userData, repo]) {
    try {
      if (folder) rmSync(folder, { recursive: true, force: true })
    } catch {
      // Windows may still hold the folder; the temp cleaner gets it.
    }
  }
})

describe(`a long relay led by ${parent}`, () => {
  test('five rounds of build, review, fix and test across three agents', async () => {
    repo = mkdtempSync(path.join(os.tmpdir(), 'beddcode-relay-'))
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.test', ...args], {
        cwd: repo,
      })
    git('init', '-q')
    writeFileSync(path.join(repo, 'README.md'), README)
    mkdirSync(path.join(repo, 'src'))
    writeFileSync(path.join(repo, 'src', 'stats.js'), "'use strict'\nmodule.exports = {}\n")
    writeFileSync(path.join(repo, 'package.json'), '{ "name": "stats", "version": "1.0.0" }\n')
    git('add', '.')
    git('commit', '-q', '-m', 'init')

    const marker = `RELAY-${crypto.randomUUID().slice(0, 6)}`
    const rounds = FUNCTIONS.map(
      (fn, i) =>
        `Round ${i + 1} (${fn}):\n` +
        `  a. send_message to the builder: add \`${fn}\` to src/stats.js exactly as README.md says, with tests in test/${fn}.test.js; run \`node --test\`. wait_for it.\n` +
        `  b. send_message to the reviewer: review the builder's change to ${fn} against README.md (read the files; edit nothing) and answer APPROVE or a numbered list of problems. wait_for it.\n` +
        `  c. send_message to the builder: apply the reviewer's problems verbatim, or answer "no changes" if it approved; run \`node --test\` again. wait_for it.\n` +
        `  d. send_message to the tester: run \`node --test\` in the repo and report the pass and fail counts, and read ${fn} in src/stats.js for README mismatches (edit nothing). wait_for it.`,
    )
    const { sessionId } = await host.rpc('sessions.create', {
      instanceId: agents[parent].id,
      cwd: repo,
      title: `Relay ${parent}`,
      agentTools: true,
      permissionMode: agents[parent].mode,
    })
    await host.wait(() => created(sessionId) !== undefined, 15_000)
    await host.rpc('sessions.prompt', {
      sessionId,
      text: [
        'You run a scripted relay of coding agents. Use only the beddcode tools (never shell, file or web tools yourself) and follow the script strictly, in order, one step at a time: always wait_for a step to finish before the next, and reuse the three sessions below with send_message instead of starting more.',
        `Setup: start three sessions in the current folder, no worktree, with start_session: the builder (agent "${agents[builder].id}", title "Builder"), the reviewer (agent "${agents[reviewer].id}", title "Reviewer"), the tester (agent "${agents[parent].id}", title "Tester"). In each first prompt say who it is and that it should read README.md in the repo and then wait for instructions, replying only READY. wait_for all three. (If a session reports blocked or failed, say so and carry on.)`,
        ...rounds,
        `At the end, write one line: ${marker} rounds=<how many you completed> problems_found=<how many review problems in total> and a short note of anything that went wrong.`,
      ].join('\n'),
    })

    const started = Date.now()
    try {
      await host.wait(() => ended(sessionId) !== undefined, 2_700_000)
    } catch {
      // Reported below as not finishing.
    }

    const kids = childrenOf(sessionId)
    const turns: any[] = []
    for (const k of kids) {
      const evs = of(k).map(({ event }) => event)
      let from = 0
      evs.forEach((e, i) => {
        if (e.type !== 'turn.completed') return
        const span = evs.slice(from, i + 1)
        const gaps = span.slice(1).map((x, j) => x.at - span[j]!.at)
        turns.push({
          session: created(k)!.title,
          agent: created(k)!.instanceId,
          reason: e.reason,
          seconds: Math.round((e.at - (span[0]?.at ?? e.at)) / 1000),
          longestSilenceSeconds: Math.round(Math.max(0, ...gaps) / 1000),
          approvals: span.filter((x) => x.type === 'approval.requested').length,
          toolErrors: span.filter((x) => x.type === 'tool.completed' && x.status === 'failed')
            .length,
          reported: span.find((x) => x.type === 'session.result')?.status,
        })
        from = i + 1
      })
    }

    // The hidden test, run against whatever the agents left in the repo.
    writeFileSync(path.join(repo, 'acceptance.test.js'), ACCEPTANCE)
    let accepted = ''
    try {
      accepted = execFileSync('node', ['--test', 'acceptance.test.js'], {
        cwd: repo,
        encoding: 'utf8',
        stdio: 'pipe',
      })
    } catch (e: any) {
      accepted = `${e.stdout ?? ''}${e.stderr ?? ''}`
    }
    const passed = Object.fromEntries(
      FUNCTIONS.map((fn) => [fn, new RegExp(`✔ ${fn}\\b`).test(accepted)]),
    )
    const ownTests = (() => {
      try {
        return execFileSync('node', ['--test', 'test/*.test.js'], {
          cwd: repo,
          encoding: 'utf8',
          stdio: 'pipe',
        })
          .split('\n')
          .filter((l) => /^ℹ (pass|fail) /.test(l))
          .join(' ')
      } catch (e: any) {
        return `failed: ${String(e.stdout ?? '')
          .split('\n')
          .filter((l) => /^ℹ (pass|fail) /.test(l))
          .join(' ')}`
      }
    })()

    Object.assign(report, {
      parent,
      builder,
      reviewer,
      minutes: Math.round((Date.now() - started) / 60_000),
      parentEnd: ended(sessionId)?.reason ?? 'no',
      finalLine: text(sessionId).trim().split('\n').at(-1),
      helperSessions: kids.length,
      helperTurns: turns.length,
      endedBad: turns.filter((t) => t.reason !== 'done').length,
      totalApprovals: turns.reduce((n, t) => n + t.approvals, 0),
      totalToolErrors: turns.reduce((n, t) => n + t.toolErrors, 0),
      slowestTurnSeconds: Math.max(0, ...turns.map((t) => t.seconds)),
      acceptance: passed,
      ownTests,
      turns,
    })

    expect(report.parentEnd).toBe('done')
    expect(text(sessionId)).toContain(`${marker} rounds=`)
    expect(ownTests).toMatch(/fail 0/)
    expect(passed, accepted.slice(-1500)).toEqual(
      Object.fromEntries(FUNCTIONS.map((f) => [f, true])),
    )
    expect(report.helperTurns, JSON.stringify(turns)).toBeGreaterThanOrEqual(20)
    expect(report.endedBad).toBe(0)
  }, 3_000_000)
})
