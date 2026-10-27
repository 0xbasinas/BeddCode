import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from '@e2e-dev/web'
import { expect } from 'e2e'
import { networkDelta, networkSnapshot } from './network.ts'

export function registerConcurrencyTests(workload: 'quick' | 'review') {
  for (const provider of [
    { name: 'claude', instanceId: 'claude' },
    { name: 'codex', instanceId: 'codex' },
    { name: 'grok', instanceId: 'acp:grok' },
  ]) {
    test(
      `${provider.name}: five concurrent sessions (${workload})`,
      { tags: [provider.name] },
      async ({ app, browser }) => {
        await app.open('/')
        const networkBefore = await networkSnapshot()
        const resources: { at: string; freeMemoryBytes: number; cpuPercent: number | null }[] = []
        let lastCpu: { idle: number; total: number } | undefined
        const sample = () => {
          const cpus = os.cpus()
          const idle = cpus.reduce((sum, cpu) => sum + cpu.times.idle, 0)
          const total = cpus.reduce(
            (sum, cpu) => sum + Object.values(cpu.times).reduce((a, b) => a + b, 0),
            0,
          )
          const deltaTotal = total - (lastCpu?.total ?? total)
          const cpuPercent =
            lastCpu && deltaTotal > 0
              ? Math.max(0, Math.min(100, 100 * (1 - (idle - lastCpu.idle) / deltaTotal)))
              : null
          lastCpu = { idle, total }
          resources.push({
            at: new Date().toISOString(),
            freeMemoryBytes: os.freemem(),
            cpuPercent,
          })
        }
        sample()
        const interval = setInterval(sample, 1000)
        let result: any
        let evaluationError: string | undefined
        try {
          result = await browser.evaluate(
            async ({ instanceId, name, workload }) => {
              type Session = {
                index: number
                id?: string
                createMs?: number
                sentAt?: number
                firstMs?: number
                durationMs?: number
                promptAckMs?: number
                reason?: string
                text: string
                error?: string
                active?: boolean
                cwd?: string
                marker?: string
                fixture?: string
                unchanged?: boolean
                eventCount: number
                assistantChunks: number
                toolCalls: number
                approvalRequests: number
                questionRequests: number
                usage: {
                  model?: string
                  inputTokens: number
                  outputTokens: number
                  cacheReadTokens?: number
                  cacheWriteTokens?: number
                  costUsd?: number
                }[]
              }
              const start = performance.now()
              const startedAt = new Date().toISOString()
              const sessions: Session[] = Array.from({ length: 5 }, (_, index) => ({
                index: index + 1,
                text: '',
                eventCount: 0,
                assistantChunks: 0,
                toolCalls: 0,
                approvalRequests: 0,
                questionRequests: 0,
                usage: [],
              }))
              const socket = new WebSocket(
                `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`,
              )
              const pending = new Map<
                string,
                { resolve: (value: any) => void; reject: (error: Error) => void }
              >()
              const sessionFolders = new Map<string, string>()
              let counter = 0
              let bytesSent = 0
              let bytesReceived = 0
              let pong: (() => void) | undefined
              const send = (frame: object) => {
                const payload = JSON.stringify(frame)
                bytesSent += new TextEncoder().encode(payload).byteLength
                socket.send(payload)
              }
              const ping = () =>
                new Promise<number | null>((resolve) => {
                  const started = performance.now()
                  const timer = setTimeout(() => {
                    pong = undefined
                    resolve(null)
                  }, 3000)
                  pong = () => {
                    clearTimeout(timer)
                    pong = undefined
                    resolve(performance.now() - started)
                  }
                  send({ t: 'ping' })
                })
              let pingBeforeMs: number | null = null
              let pingAfterMs: number | null = null
              let active = 0
              let peakActive = 0
              let ready: () => void = () => {}
              let done: () => void = () => {}
              const welcome = new Promise<void>((resolve) => {
                ready = resolve
              })
              const completed = new Promise<void>((resolve) => {
                done = resolve
              })
              const rpc = (method: string, params: object): Promise<any> =>
                new Promise((resolve, reject) => {
                  const id = `load-${++counter}`
                  const timer = setTimeout(() => {
                    pending.delete(id)
                    reject(new Error(`${method} timed out`))
                  }, 45_000)
                  pending.set(id, {
                    resolve: (value) => {
                      clearTimeout(timer)
                      resolve(value)
                    },
                    reject: (error) => {
                      clearTimeout(timer)
                      reject(error)
                    },
                  })
                  send({ t: 'req', id, method, params })
                })
              const consume = (event: any) => {
                if (event.type === 'session.created') sessionFolders.set(event.sessionId, event.cwd)
                const session = sessions.find((item) => item.id === event.sessionId)
                if (!session) return
                session.eventCount++
                if (event.type === 'tool.started') session.toolCalls++
                if (event.type === 'approval.requested') session.approvalRequests++
                if (event.type === 'question.requested') session.questionRequests++
                if (event.type === 'session.usage')
                  session.usage.push({
                    model: event.model,
                    inputTokens: event.inputTokens,
                    outputTokens: event.outputTokens,
                    cacheReadTokens: event.cacheReadTokens,
                    cacheWriteTokens: event.cacheWriteTokens,
                    costUsd: event.costUsd,
                  })
                if (event.type === 'turn.started') {
                  session.active = true
                  active++
                  peakActive = Math.max(peakActive, active)
                }
                if (event.type === 'message.delta' && event.role === 'assistant') {
                  session.assistantChunks++
                  if (session.firstMs === undefined && session.sentAt !== undefined)
                    session.firstMs = performance.now() - session.sentAt
                  session.text += event.text
                }
                if (event.type === 'approval.requested' || event.type === 'question.requested') {
                  session.error = `Unexpected ${event.type}`
                  void rpc('sessions.interrupt', { sessionId: session.id }).catch(() => {})
                }
                if (event.type === 'turn.completed') {
                  session.reason = event.reason
                  if (session.active) {
                    active--
                    session.active = false
                  }
                  if (session.sentAt !== undefined)
                    session.durationMs = performance.now() - session.sentAt
                  if (sessions.every((item) => item.reason || item.error)) done()
                }
              }
              socket.onmessage = ({ data }) => {
                if (typeof data === 'string')
                  bytesReceived += new TextEncoder().encode(data).byteLength
                const frame = JSON.parse(data)
                if (frame.t === 'welcome') {
                  send({ t: 'subscribe', afterSeq: 0 })
                  ready()
                }
                if (frame.t === 'pong') pong?.()
                if (frame.t === 'res') {
                  const entry = pending.get(frame.id)
                  if (entry) {
                    pending.delete(frame.id)
                    frame.ok ? entry.resolve(frame.result) : entry.reject(new Error(frame.error))
                  }
                }
                if (frame.t === 'event') consume(frame.stored.event)
                if (frame.t === 'events') for (const stored of frame.events) consume(stored.event)
              }
              socket.onopen = () => send({ t: 'hello', protocol: 1 })
              let failure: string | undefined
              try {
                await Promise.race([
                  welcome,
                  new Promise<never>((_, reject) =>
                    setTimeout(() => reject(new Error('Connection timed out')), 15_000),
                  ),
                ])
                pingBeforeMs = await ping()
                await Promise.all(
                  sessions.map(async (session) => {
                    const began = performance.now()
                    try {
                      const created = await rpc('sessions.create', {
                        instanceId,
                        projectless: true,
                        title: `Load test ${session.index}`,
                        ...(workload === 'review'
                          ? {
                              permissionMode:
                                name === 'codex'
                                  ? 'read-only'
                                  : name === 'grok'
                                    ? 'ask'
                                    : 'default',
                            }
                          : {}),
                      })
                      session.id = created.sessionId
                      session.createMs = performance.now() - began
                      if (workload === 'review') {
                        session.cwd = sessionFolders.get(session.id!)
                        if (!session.cwd)
                          throw new Error('Session workspace event was not received')
                        session.marker = `BUG-${session.index}-${crypto.randomUUID().slice(0, 8)}`
                        session.fixture = `// ${session.marker}\nexport function reserveStock(stock: number, quantity: number): number {\n  if (quantity <= 0) throw new Error('quantity must be positive')\n  return stock - quantity\n}\n`
                        await rpc('files.create', {
                          cwd: session.cwd,
                          path: 'inventory.ts',
                          type: 'file',
                        })
                        await rpc('files.write', {
                          cwd: session.cwd,
                          path: 'inventory.ts',
                          content: session.fixture,
                        })
                      }
                    } catch (error) {
                      session.error = String(error)
                    }
                  }),
                )
                await Promise.all(
                  sessions
                    .filter((session) => session.id && !session.error)
                    .map(async (session) => {
                      session.sentAt = performance.now()
                      try {
                        const response = await rpc('sessions.prompt', {
                          sessionId: session.id,
                          text:
                            workload === 'quick'
                              ? 'Without using tools, reply with only the single word PONG.'
                              : 'Read inventory.ts in this workspace. Identify the bug and report its BUG identifier from the file. Briefly explain the consequence. Do not edit files or run tests.',
                        })
                        session.promptAckMs = performance.now() - session.sentAt
                        if (response.state !== 'started')
                          session.error = `Unexpected prompt state: ${response.state}`
                      } catch (error) {
                        session.error = String(error)
                      }
                    }),
                )
                if (!sessions.every((item) => item.reason || item.error)) {
                  await Promise.race([
                    completed,
                    new Promise<never>((_, reject) =>
                      setTimeout(() => reject(new Error('Timed out waiting for turns')), 90_000),
                    ),
                  ])
                }
                if (workload === 'review') {
                  await Promise.all(
                    sessions
                      .filter((item) => item.cwd && item.fixture)
                      .map(async (item) => {
                        try {
                          const file = await rpc('files.read', {
                            cwd: item.cwd,
                            path: 'inventory.ts',
                          })
                          item.unchanged = file.content === item.fixture
                        } catch (error) {
                          item.error = `Fixture verification failed: ${String(error)}`
                        }
                      }),
                  )
                }
                pingAfterMs = await ping()
              } catch (error) {
                failure = String(error)
              } finally {
                // Stop incomplete turns; the temporary host is shut down by the runner afterwards.
                await Promise.all(
                  sessions
                    .filter((item) => item.id && !item.reason)
                    .map((item) =>
                      Promise.race([
                        rpc('sessions.interrupt', { sessionId: item.id }).catch(() => {}),
                        new Promise((resolve) => setTimeout(resolve, 2_000)),
                      ]),
                    ),
                )
                socket.close()
              }
              return JSON.parse(
                JSON.stringify({
                  provider: name,
                  workload,
                  startedAt,
                  totalMs: performance.now() - start,
                  peakActive,
                  failure,
                  transport: {
                    localPingBeforeMs: pingBeforeMs,
                    localPingAfterMs: pingAfterMs,
                    websocketPayloadBytesSent: bytesSent,
                    websocketPayloadBytesReceived: bytesReceived,
                  },
                  sessions: sessions.map(
                    ({
                      sentAt: _sentAt,
                      active: _active,
                      text,
                      cwd: _cwd,
                      fixture: _fixture,
                      ...item
                    }) => ({
                      ...item,
                      responseCharacters: text.length,
                      responseOk:
                        workload === 'quick'
                          ? /\bPONG\b/i.test(text)
                          : !!item.marker &&
                            text.includes(item.marker) &&
                            /negative|below zero|less than zero|underflow|insufficient|exceed/i.test(
                              text,
                            ),
                    }),
                  ),
                }),
              )
            },
            { ...provider, workload },
          )
        } catch (error) {
          evaluationError = error instanceof Error ? error.message : String(error)
        } finally {
          clearInterval(interval)
          sample()
        }
        const networkAfter = await networkSnapshot()
        const summarize = (values: number[]) => {
          const sorted = values.filter(Number.isFinite).sort((a, b) => a - b)
          const percentile = (p: number) =>
            sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null
          return {
            count: sorted.length,
            min: sorted[0] ?? null,
            median: percentile(0.5),
            p95: percentile(0.95),
            max: sorted.at(-1) ?? null,
            mean: sorted.length ? sorted.reduce((a, b) => a + b, 0) / sorted.length : null,
          }
        }
        const sessions = result?.sessions ?? []
        const usage = sessions.flatMap((item: any) => item.usage ?? [])
        const costEvents = usage.filter((entry: any) => typeof entry.costUsd === 'number')
        const report = {
          schemaVersion: 2,
          ...(result ?? { provider: provider.name }),
          evaluationError,
          summary: {
            created: sessions.filter((item: any) => item.id).length,
            completed: sessions.filter((item: any) => item.reason === 'done').length,
            passed: sessions.filter(
              (item: any) => item.reason === 'done' && item.responseOk && !item.error,
            ).length,
            errors: sessions.filter(
              (item: any) => item.error || (item.reason && item.reason !== 'done'),
            ).length,
            incomplete: sessions.filter((item: any) => !item.reason && !item.error).length,
            usageReportedSessions: sessions.filter((item: any) => item.usage?.length > 0).length,
            reportedUsage: usage.length
              ? {
                  inputTokens: usage.reduce(
                    (sum: number, entry: any) => sum + entry.inputTokens,
                    0,
                  ),
                  outputTokens: usage.reduce(
                    (sum: number, entry: any) => sum + entry.outputTokens,
                    0,
                  ),
                  cacheReadTokens: usage.some(
                    (entry: any) => typeof entry.cacheReadTokens === 'number',
                  )
                    ? usage.reduce(
                        (sum: number, entry: any) => sum + (entry.cacheReadTokens ?? 0),
                        0,
                      )
                    : null,
                  cacheWriteTokens: usage.some(
                    (entry: any) => typeof entry.cacheWriteTokens === 'number',
                  )
                    ? usage.reduce(
                        (sum: number, entry: any) => sum + (entry.cacheWriteTokens ?? 0),
                        0,
                      )
                    : null,
                  costUsd: costEvents.length
                    ? costEvents.reduce((sum: number, entry: any) => sum + entry.costUsd, 0)
                    : null,
                  costReportedEvents: costEvents.length,
                  usageEvents: usage.length,
                }
              : null,
            creationMs: summarize(sessions.map((item: any) => item.createMs)),
            firstResponseMs: summarize(sessions.map((item: any) => item.firstMs)),
            completionMs: summarize(sessions.map((item: any) => item.durationMs)),
            promptAckMs: summarize(sessions.map((item: any) => item.promptAckMs)),
          },
          system: {
            platform: process.platform,
            architecture: process.arch,
            logicalCpus: os.cpus().length,
            totalMemoryBytes: os.totalmem(),
            sampleIntervalMs: 1000,
            minFreeMemoryBytes: Math.min(...resources.map((item) => item.freeMemoryBytes)),
            cpuPercent: summarize(
              resources.map((item) => item.cpuPercent).filter((v): v is number => v !== null),
            ),
            samples: resources,
          },
          network: networkDelta(networkBefore, networkAfter),
        }
        const directory = path.resolve('.e2e/concurrency-stats')
        mkdirSync(directory, { recursive: true })
        const file = path.join(directory, `${Date.now()}-${provider.name}-${workload}.json`)
        writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`)
        const fmt = (n: number | null | undefined, suffix = '') =>
          n == null ? 'unavailable' : `${Math.round(n * 10) / 10}${suffix}`
        const rows = [
          ['Passed', `${report.summary.passed}/5`],
          ['Peak overlapping turns', String(result?.peakActive ?? 'unavailable')],
          ['Test workload duration', fmt(result?.totalMs, ' ms')],
          [
            'Session creation median / p95',
            `${fmt(report.summary.creationMs.median, ' ms')} / ${fmt(report.summary.creationMs.p95, ' ms')}`,
          ],
          [
            'First response median / p95',
            `${fmt(report.summary.firstResponseMs.median, ' ms')} / ${fmt(report.summary.firstResponseMs.p95, ' ms')}`,
          ],
          [
            'Completion median / p95',
            `${fmt(report.summary.completionMs.median, ' ms')} / ${fmt(report.summary.completionMs.p95, ' ms')}`,
          ],
          [
            'Prompt acknowledgement median / p95',
            `${fmt(report.summary.promptAckMs.median, ' ms')} / ${fmt(report.summary.promptAckMs.p95, ' ms')}`,
          ],
          [
            'Local host ping before / after',
            `${fmt(result?.transport?.localPingBeforeMs, ' ms')} / ${fmt(result?.transport?.localPingAfterMs, ' ms')}`,
          ],
          [
            'Test WebSocket payload sent / received',
            `${fmt(result?.transport?.websocketPayloadBytesSent, ' bytes')} / ${fmt(result?.transport?.websocketPayloadBytesReceived, ' bytes')}`,
          ],
          [
            'System CPU mean / peak',
            `${fmt(report.system.cpuPercent.mean, '%')} / ${fmt(report.system.cpuPercent.max, '%')}`,
          ],
          ['System minimum free memory', fmt(report.system.minFreeMemoryBytes / 1024 ** 2, ' MiB')],
        ]
        for (const iface of report.network.interfaces.filter(
          (item) => item.type === 'Wireless80211',
        )) {
          rows.push([
            `Wi-Fi (${iface.name}) received / sent`,
            `${fmt(iface.receivedBytes, ' bytes')} / ${fmt(iface.sentBytes, ' bytes')}`,
          ])
          rows.push([
            `Wi-Fi (${iface.name}) average receive / send`,
            `${fmt(iface.averageReceiveBytesPerSecond == null ? null : iface.averageReceiveBytesPerSecond / 1024, ' KiB/s')} / ${fmt(iface.averageSendBytesPerSecond == null ? null : iface.averageSendBytesPerSecond / 1024, ' KiB/s')}`,
          ])
        }
        if (report.network.error) rows.push(['Network counters', 'unavailable; see JSON report'])
        writeFileSync(
          file.replace(/\.json$/, '.md'),
          `# ${provider.name} concurrency test (${workload})\n\n| Metric | Result |\n| --- | --- |\n${rows.map(([metric, value]) => `| ${metric} | ${value} |`).join('\n')}\n\nSystem CPU, memory and network counters include all processes. Host ping is local, not internet latency. Percentiles use nearest rank and only five sessions. See the JSON file for samples, errors, and optional provider-reported usage.\n`,
        )
        console.log(`Concurrency statistics: ${file}`)
        if (evaluationError)
          throw new Error(`Could not collect session results: ${evaluationError}`)
        expect(result.failure).toBeUndefined()
        expect(
          result.sessions.filter(
            (item) => item.reason === 'done' && item.responseOk && !item.error,
          ),
        ).toHaveLength(5)
        if (workload === 'review') {
          expect(
            result.sessions.filter((item) => item.unchanged && item.toolCalls > 0),
          ).toHaveLength(5)
        }
        expect(result.peakActive).toBe(5)
      },
    )
  }
}
