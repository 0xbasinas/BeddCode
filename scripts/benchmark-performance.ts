import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import type { StoredEvent } from '../packages/contracts/src/events.ts'
import { buildBlocks, createBlockBuilder } from '../packages/client-runtime/src/blocks.ts'
import {
  applyEvent,
  applyEvents,
  emptyReplica,
  type TranscriptItem,
} from '../packages/client-runtime/src/replica.ts'
import { encodeSnapshot, SNAPSHOT_VERSION } from '../packages/client-runtime/src/replicaCache.ts'

// Run: pnpm --filter @beddcode/server exec tsx ../../scripts/benchmark-performance.ts
// Synthetic CPU comparisons, not UI frame times or network/disk measurements.
let checksum = 0
function median(run: () => void) {
  run()
  const times = Array.from({ length: 7 }, () => {
    const start = performance.now()
    run()
    return performance.now() - start
  }).sort((a, b) => a - b)
  return Number(times[3]!.toFixed(2))
}

const items: TranscriptItem[] = []
for (let turn = 0; turn < 400; turn++) {
  items.push({ kind: 'message', id: `u${turn}`, role: 'user', text: 'Prompt' })
  for (let file = 0; file < 5; file++)
    items.push({
      kind: 'diff',
      id: `d${turn}:${file}`,
      path: `${file}.ts`,
      added: 1,
      removed: 0,
      patch: '+a line\n'.repeat(20),
    })
  items.push({ kind: 'message', id: `a${turn}`, role: 'assistant', text: 'Reply' })
}
const seed = applyEvent(emptyReplica(), {
  seq: 1,
  event: {
    type: 'session.created',
    sessionId: 's',
    at: 1,
    title: 'Benchmark',
    cwd: '/tmp',
    instanceId: 'fake',
  },
})
seed.sessions.s = { ...seed.sessions.s!, items }
const deltas: StoredEvent[] = Array.from({ length: 1000 }, (_, n) => ({
  seq: n + 2,
  event: {
    type: 'message.delta',
    role: 'assistant',
    sessionId: 's',
    at: n + 2,
    text: 'word ',
  },
}))
assert.deepEqual(applyEvents(seed, deltas), deltas.reduce(applyEvent, seed))

const updates = Array.from({ length: 100 }, (_, n) => [
  ...items.slice(0, -1),
  { kind: 'message' as const, id: 'last', role: 'assistant' as const, text: `Reply ${n}` },
])
const builder = createBlockBuilder()
builder(items)
for (const update of updates) assert.deepEqual(builder(update), buildBlocks(update))

const replica = emptyReplica()
for (let n = 0; n < 120; n++) {
  const id = `s${n}`
  replica.order.push(id)
  replica.sessions[id] = {
    ...seed.sessions.s!,
    id,
    items: Array.from({ length: 25 }, (_, i) => ({
      kind: 'message',
      id: `${i}`,
      role: 'assistant',
      text: 'x'.repeat(400),
    })),
  }
}
const snapshot = { v: SNAPSHOT_VERSION, seq: 1, logId: 'benchmark', replica }
assert.deepEqual(JSON.parse(encodeSnapshot(snapshot)!), JSON.parse(JSON.stringify(snapshot)))

const results = [
  {
    workload: '1,000 deltas, 2,800 existing transcript items',
    beforeMs: median(() => {
      checksum += deltas.reduce(applyEvent, seed).lastSeq
    }),
    afterMs: median(() => {
      checksum += applyEvents(seed, deltas).lastSeq
    }),
  },
  {
    workload: '100 renders, 400 turns with 2,000 diffs',
    beforeMs: median(() => {
      for (const update of updates) checksum += buildBlocks(update).length
    }),
    afterMs: median(() => {
      const build = createBlockBuilder()
      build(items)
      for (const update of updates) checksum += build(update).length
    }),
  },
  {
    workload: 'Warm snapshot encoding, 120 unchanged sessions',
    beforeMs: median(() => {
      checksum += Buffer.byteLength(JSON.stringify(snapshot))
    }),
    afterMs: median(() => {
      checksum += Buffer.byteLength(encodeSnapshot(snapshot)!)
    }),
  },
]
console.log(
  JSON.stringify({ node: process.version, platform: process.platform, results, checksum }, null, 2),
)
