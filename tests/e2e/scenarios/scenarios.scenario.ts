import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { Host } from '../../shared/hostClient.ts'
import { networkDelta, networkSnapshot } from '../concurrency/network.ts'

const exec = promisify(execFile)
const providers = [
  { name: 'claude', id: 'claude', mode: 'acceptEdits' },
  { name: 'codex', id: 'codex', mode: 'auto' },
  { name: 'grok', id: 'acp:grok', mode: 'ask' },
]
const kinds = ['fix', 'multi-turn', 'run-tests', 'reconnect', 'soak', 'mixed'] as const
type Kind = (typeof kinds)[number]
const source = `export function reserve(stock, quantity) {\n  if (quantity <= 0) throw new RangeError('quantity must be positive')\n  return stock - quantity\n}\n`
const agentTest = `import { test } from 'node:test'\nimport { strict as assert } from 'node:assert'\nimport { reserve } from './inventory.mjs'\ntest('rejects overbooking', () => assert.throws(() => reserve(2, 3), RangeError))\n`
const oracle = `import { pathToFileURL } from 'node:url'; import assert from 'node:assert/strict'; const { reserve } = await import(pathToFileURL(process.argv[1]).href); assert.equal(reserve(5, 3), 2); assert.throws(() => reserve(2, 3), RangeError); if (process.argv[2] === 'zero') assert.equal(reserve(5, 0), 5);`
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function processSample(pid: number) {
  if (process.platform !== 'win32')
    return {
      at: new Date().toISOString(),
      error: 'Process tree sampling currently supports Windows only',
    }
  try {
    const script = `$all=Get-CimInstance Win32_Process; $ids=@(${pid}); do { $old=$ids.Count; $ids=@($ids + @($all | Where-Object { $ids -contains $_.ParentProcessId } | ForEach-Object { [int]$_.ProcessId }) | Select-Object -Unique) } while ($ids.Count -gt $old); @(Get-Process -Id $ids -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{pid=$_.Id; name=$_.ProcessName; workingSetBytes=$_.WorkingSet64; cpuSeconds=$_.CPU} }) | ConvertTo-Json -Compress`
    const { stdout } = await exec(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: 8000, windowsHide: true },
    )
    const processes = JSON.parse(stdout.trim() || '[]')
    return {
      at: new Date().toISOString(),
      processes: Array.isArray(processes) ? processes : [processes],
    }
  } catch (error) {
    return { at: new Date().toISOString(), error: String(error) }
  }
}

for (const provider of providers)
  for (const kind of kinds) {
    test(
      `${provider.name}: ${kind}`,
      { tags: [provider.name, kind], timeout: 2_100_000 },
      async ({ app }) => {
        const startedAt = new Date().toISOString()
        const start = performance.now()
        const base = new URL(app.baseUrl)
        const wsUrl = `${base.protocol === 'https:' ? 'wss:' : 'ws:'}//${base.host}/ws`
        const host = new Host(wsUrl)
        const result: any = {
          provider: provider.name,
          scenario: kind,
          startedAt,
          sessions: [],
          processSamples: [],
        }
        const netBefore = await networkSnapshot()
        let sampling = false
        let sampleTimer: ReturnType<typeof setInterval> | undefined
        let observer: Host | undefined
        try {
          const { pid } = JSON.parse(
            await readFile(path.resolve('.e2e', `host-${base.port}.json`), 'utf8'),
          )
          const take = async () => {
            if (sampling) return
            sampling = true
            try {
              result.processSamples.push({
                ...(await processSample(pid)),
                freeMemoryBytes: os.freemem(),
              })
            } finally {
              sampling = false
            }
          }
          await take()
          sampleTimer = setInterval(() => void take(), 3000)
          await host.connect()
          const count =
            kind === 'soak'
              ? Math.max(1, Math.min(5, Number(process.env.BEDDCODE_SOAK_SESSIONS) || 3))
              : 5
          const sessions = await Promise.all(
            Array.from({ length: count }, async (_, index) => {
              const created = await host.rpc('sessions.create', {
                instanceId: provider.id,
                projectless: true,
                permissionMode: provider.mode,
                title: `${kind} ${index + 1}`,
              })
              await host.wait(
                () =>
                  host.events.some(
                    ({ event }) =>
                      event.type === 'session.created' && event.sessionId === created.sessionId,
                  ),
                15_000,
              )
              const cwd = host.events.find(
                ({ event }) =>
                  event.type === 'session.created' && event.sessionId === created.sessionId,
              )!.event.cwd as string
              const task =
                kind === 'mixed'
                  ? (['fix', 'review', 'run-tests', 'explain', 'fix'] as const)[index]!
                  : kind
              const session: {
                id: string
                cwd: string
                task: string
                turns: any[]
                oraclePassed: boolean
                fixtureTestUnchanged?: boolean
                testRunObserved?: boolean
                oracleError?: string
                approvedTestTools?: string[]
                approvalLog?: string[]
                lastEvents?: string[]
              } = {
                id: created.sessionId as string,
                cwd,
                task,
                turns: [] as any[],
                oraclePassed: false,
              }
              await writeFile(path.join(cwd, 'inventory.mjs'), source)
              await writeFile(path.join(cwd, 'inventory.test.mjs'), agentTest)
              return session
            }),
          )
          result.sessions = sessions
          const prompt = (task: string) =>
            task === 'review' || task === 'reconnect' || task === 'soak'
              ? 'Read inventory.mjs. Explain briefly how stock can become negative. Do not change any files.'
              : task === 'explain'
                ? 'Read inventory.mjs and explain what reserve does. Do not edit files.'
                : `Fix inventory.mjs so reserve throws RangeError when quantity exceeds stock, while preserving existing behavior. You may use commands to inspect files. ${task === 'run-tests' ? 'Run exactly `node --test inventory.test.mjs` (no pipes, redirects or extra arguments) to check your change.' : 'Do not run tests.'} Do not change inventory.test.mjs.`
          const sendTurn = async (session: (typeof sessions)[number], text: string) => {
            const before = host.events.length
            const sent = performance.now()
            const sentWall = Date.now()
            const reply = await host.rpc('sessions.prompt', { sessionId: session.id, text })
            if (reply.state !== 'started')
              throw new Error(`Unexpected prompt state: ${reply.state}`)
            return { before, sent, sentWall }
          }
          const turns = await Promise.all(
            sessions.map((session) => sendTurn(session, prompt(session.task))),
          )
          if (kind === 'reconnect') {
            observer = new Host(wsUrl)
            await observer.connect()
            await host.wait(
              () =>
                sessions.some((s) =>
                  host.events.some(
                    ({ event }) => event.sessionId === s.id && event.type === 'turn.started',
                  ),
                ),
              30_000,
            )
            const cursor = observer.sequence
            const previous = observer.events.slice()
            if (
              sessions.every((s) =>
                host.events.some(
                  ({ event }) => event.sessionId === s.id && event.type === 'turn.completed',
                ),
              )
            ) {
              throw new Error('All turns completed before the reconnect interruption')
            }
            observer.close()
            await pause(500)
            const resumed = new Host(wsUrl)
            const before = performance.now()
            await resumed.connect(cursor)
            result.reconnectMs = performance.now() - before
            result.resumeCursor = cursor
            result.observerBefore = previous
            observer = resumed
          }
          const approved = new Set<string>()
          const waitTurns = async (
            indices: { before: number; sent: number; sentWall: number }[],
          ) => {
            const finished = new Set<string>()
            const deadline = Date.now() + 150_000
            while (finished.size < sessions.length) {
              const seen = host.events.length
              for (let i = 0; i < sessions.length; i++) {
                const session = sessions[i]!
                const records = host.events
                  .slice(indices[i]!.before)
                  .filter(({ event }) => event.sessionId === session.id)
                for (const { event } of records) {
                  if (
                    event.type === 'approval.requested' &&
                    !approved.has(`${session.id}:${event.requestId}`)
                  ) {
                    approved.add(`${session.id}:${event.requestId}`)
                    const details = `${event.title ?? ''} ${event.detail ?? ''}`
                    const tool = records.find(
                      (record) =>
                        record.event.type === 'tool.started' &&
                        record.event.toolId === event.toolId,
                    )?.event
                    const titledPath = /^Edit\s+`([^`]+)`/.exec(event.title ?? '')?.[1]
                    const approvedEdit =
                      (tool?.kind === 'edit' &&
                        Array.isArray(tool.paths) &&
                        tool.paths.length > 0 &&
                        tool.paths.every(
                          (p: string) =>
                            path.resolve(session.cwd, p) ===
                            path.resolve(session.cwd, 'inventory.mjs'),
                        )) ||
                      (titledPath !== undefined &&
                        path.resolve(session.cwd, titledPath).toLowerCase() ===
                          path.resolve(session.cwd, 'inventory.mjs').toLowerCase())
                    const approvedTest =
                      session.task === 'run-tests' &&
                      /^node\s+--test\s+inventory\.test\.mjs(\s+2>&1)?(\s*\|\s*tail(\s+-\d+)?)?\s*$/.test(
                        (event.detail ?? '')
                          .trim()
                          .replace(/^cd\s+"([^"]+)"\s+&&\s+/, (m: string, dir: string) =>
                            path.resolve(dir).toLowerCase() ===
                            path.resolve(session.cwd).toLowerCase()
                              ? ''
                              : m,
                          ),
                      )
                    const allow = event.options?.find(
                      (option: any) =>
                        option.kind === 'allow' && !/always|session/i.test(option.label),
                    )
                    if ((approvedEdit || approvedTest) && allow) {
                      if (approvedTest && event.toolId)
                        session.approvedTestTools = [
                          ...(session.approvedTestTools ?? []),
                          event.toolId,
                        ]
                      const t0 = Date.now()
                      session.approvalLog = [...(session.approvalLog ?? []), `start ${t0}`]
                      await host.rpc('sessions.approve', {
                        sessionId: session.id,
                        requestId: event.requestId,
                        optionId: allow.id,
                      })
                      session.approvalLog.push(`done +${Date.now() - t0}ms`)
                    } else {
                      session.turns.push({ approval: details.slice(0, 500) })
                      await host.rpc('sessions.interrupt', { sessionId: session.id })
                    }
                  }
                }
                const end = records.find(({ event }) => event.type === 'turn.completed')
                if (end && !finished.has(session.id)) {
                  const text = records
                    .filter(
                      ({ event }) => event.type === 'message.delta' && event.role === 'assistant',
                    )
                    .map(({ event }) => event.text)
                    .join('')
                  session.turns.push({
                    reason: end.event.reason,
                    durationMs: Math.max(0, end.event.at - indices[i]!.sentWall),
                    firstResponseMs: (() => {
                      const first = records.find(
                        ({ event }) => event.type === 'message.delta' && event.role === 'assistant',
                      )
                      return first ? Math.max(0, first.event.at - indices[i]!.sentWall) : null
                    })(),
                    text,
                    toolCalls: records.filter(({ event }) => event.type === 'tool.started').length,
                    tools: records
                      .filter(({ event }) => event.type === 'tool.started')
                      .map(({ event }) => ({
                        id: event.toolId,
                        kind: event.kind,
                        title: event.title,
                      })),
                    toolResults: records
                      .filter(({ event }) => event.type === 'tool.completed')
                      .map(({ event }) => ({ id: event.toolId, ok: event.ok })),
                  })
                  finished.add(session.id)
                }
              }
              if (finished.size === sessions.length) break
              const left = deadline - Date.now()
              if (left <= 0) throw new Error('turns timed out')
              await host.wait(() => host.events.length > seen, left)
            }
          }
          await waitTurns(turns)
          if (kind === 'multi-turn') {
            const next = await Promise.all(
              sessions.map((session) =>
                sendTurn(
                  session,
                  'Now also allow quantity zero and return the unchanged stock. Keep the previous overbooking fix. You may use commands to inspect files; do not run tests.',
                ),
              ),
            )
            await waitTurns(next)
          }
          if (kind === 'soak') {
            const minutes = Math.max(
              10,
              Math.min(30, Number(process.env.BEDDCODE_SOAK_MINUTES) || 12),
            )
            result.soakMinutes = minutes
            for (let i = 0; i < 2; i++) {
              await pause((minutes * 60_000) / 2)
              const next = await Promise.all(
                sessions.map((session) =>
                  sendTurn(
                    session,
                    'Without using tools, summarize the inventory issue in one sentence.',
                  ),
                ),
              )
              await waitTurns(next)
            }
          }
          for (const session of sessions) {
            if (['fix', 'run-tests', 'multi-turn'].includes(session.task)) {
              const checked = await exec(
                process.execPath,
                [
                  '--input-type=module',
                  '-e',
                  oracle,
                  path.join(session.cwd, 'inventory.mjs'),
                  kind === 'multi-turn' ? 'zero' : 'normal',
                ],
                { timeout: 15_000 },
              ).then(
                () => ({ ok: true }),
                (error) => ({ ok: false, error: String(error) }),
              )
              session.oraclePassed = checked.ok
              if (!checked.ok) (session as any).oracleError = checked.error
              session.fixtureTestUnchanged =
                (await readFile(path.join(session.cwd, 'inventory.test.mjs'), 'utf8')) === agentTest
              if (session.task === 'run-tests') {
                session.testRunObserved = session.turns.some((turn: any) =>
                  turn.tools?.some(
                    (tool: any) =>
                      (/node(?:\.exe)?\s+--test\s+inventory\.test\.mjs/i.test(tool.title) ||
                        session.approvedTestTools?.includes(tool.id)) &&
                      turn.toolResults?.some(
                        (outcome: any) => outcome.id === tool.id && outcome.ok,
                      ),
                  ),
                )
              }
            } else
              session.oraclePassed = session.turns.some(
                (turn: any) => turn.reason === 'done' && turn.text.trim().length > 0,
              )
          }
          if (kind === 'reconnect' && observer) {
            await observer.wait(
              () =>
                sessions.every((s) =>
                  [...result.observerBefore, ...observer!.events].some(
                    ({ event }) => event.sessionId === s.id && event.type === 'turn.completed',
                  ),
                ),
              30_000,
            )
            const seqs = [...result.observerBefore, ...observer.events].map(
              (record: any) => record.seq,
            )
            result.reconnectDuplicates = seqs.length - new Set(seqs).size
            result.reconnectedCompletions = sessions.filter((s) =>
              [...result.observerBefore, ...observer!.events].some(
                ({ event }) => event.sessionId === s.id && event.type === 'turn.completed',
              ),
            ).length
            result.reconnectTextMatches = sessions.every((s) => {
              const replay = [...result.observerBefore, ...observer!.events]
                .filter(
                  ({ event }: any) =>
                    event.sessionId === s.id &&
                    event.type === 'message.delta' &&
                    event.role === 'assistant',
                )
                .map(({ event }: any) => event.text)
                .join('')
              return replay === s.turns[0]?.text
            })
            delete result.observerBefore
          }
          const active = new Set<string>()
          result.peakActive = 0
          for (const { event } of host.events) {
            if (!sessions.some((session) => session.id === event.sessionId)) continue
            if (event.type === 'turn.started') active.add(event.sessionId)
            if (event.type === 'turn.completed') active.delete(event.sessionId)
            result.peakActive = Math.max(result.peakActive, active.size)
          }
          result.ok =
            sessions.every(
              (s) =>
                s.oraclePassed &&
                s.turns.length >= (kind === 'multi-turn' ? 2 : kind === 'soak' ? 3 : 1) &&
                s.turns.every((t: any) => t.reason === 'done') &&
                s.fixtureTestUnchanged !== false &&
                (s.task !== 'run-tests' || s.testRunObserved),
            ) &&
            result.peakActive === count &&
            (kind !== 'reconnect' ||
              (result.reconnectDuplicates === 0 &&
                result.reconnectedCompletions === count &&
                result.reconnectTextMatches))
        } catch (error) {
          result.ok = false
          result.error = error instanceof Error ? error.message : String(error)
          for (const session of result.sessions) {
            session.lastEvents = host.events
              .filter(({ event }) => event.sessionId === session.id)
              .slice(-6)
              .map(({ event }) =>
                JSON.stringify(event, (_k, v) => (typeof v === 'string' ? v.slice(0, 160) : v)),
              )
          }
        } finally {
          if (sampleTimer) clearInterval(sampleTimer)
          await Promise.all(
            result.sessions
              .filter((s: any) => s.id)
              .map((s: any) =>
                Promise.race([
                  host.rpc('sessions.interrupt', { sessionId: s.id }).catch(() => {}),
                  pause(2000),
                ]),
              ),
          )
          observer?.close()
          if (host.socket) host.close()
          result.elapsedMs = performance.now() - start
          const samples = result.processSamples.filter((sample: any) =>
            Array.isArray(sample.processes),
          )
          result.processSummary = {
            successfulSamples: samples.length,
            failedSamples: result.processSamples.length - samples.length,
            peakSummedWorkingSetBytes: samples.length
              ? Math.max(
                  ...samples.map((sample: any) =>
                    sample.processes.reduce((sum: number, p: any) => sum + p.workingSetBytes, 0),
                  ),
                )
              : null,
            minSystemFreeMemoryBytes: result.processSamples.length
              ? Math.min(...result.processSamples.map((sample: any) => sample.freeMemoryBytes))
              : null,
          }
          result.system = { totalMemoryBytes: os.totalmem(), freeMemoryBytes: os.freemem() }
          result.network = networkDelta(netBefore, await networkSnapshot())
          const dir = path.resolve('.e2e/scenario-stats')
          await mkdir(dir, { recursive: true })
          const file = path.join(dir, `${Date.now()}-${provider.name}-${kind}.json`)
          await writeFile(file, `${JSON.stringify(result, null, 2)}\n`)
          console.log(`Scenario statistics: ${file}`)
        }
        expect(result.ok).toBe(true)
      },
    )
  }
