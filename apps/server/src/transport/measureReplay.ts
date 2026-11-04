/** Run with: npx -y pnpm@12.14.0 --filter @beddcode/server exec tsx src/transport/measureReplay.ts */
import { performance } from 'node:perf_hooks'
import { EventStore } from '../store/eventStore.ts'
import { replaySubscription } from './replay.ts'

const store = new EventStore(':memory:')
const count = 5000
for (let n = 0; n < count; n++) {
  store.append({
    type: 'message.delta',
    sessionId: 's',
    turnId: 't',
    role: 'assistant',
    at: n,
    text: 'é'.repeat(4096),
  })
}
const heapBefore = process.memoryUsage().heapUsed
let peakHeap = heapBefore
let bytes = 0
let largest = 0
let frames = 0
let maxDelay = 0
let lastTick = performance.now()
const tick = setInterval(() => {
  const now = performance.now()
  maxDelay = Math.max(maxDelay, now - lastTick)
  lastTick = now
  peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
}, 1)
const start = performance.now()
await new Promise<void>((resolve, reject) => {
  replaySubscription({
    store,
    afterSeq: 0,
    batch: true,
    backlog: () => 0,
    live: () => {},
    send: (frame) => {
      const size = Buffer.byteLength(JSON.stringify(frame))
      bytes += size
      largest = Math.max(largest, size)
      frames++
      peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed)
    },
    failed: () => reject(new Error('replay failed')),
    caughtUp: () => resolve(),
  })
})
clearInterval(tick)
console.log(
  JSON.stringify(
    {
      events: count,
      bytes,
      frames,
      largestFrameBytes: largest,
      heapGrowthBytes: peakHeap - heapBefore,
      elapsedMs: Math.round(performance.now() - start),
      maxTimerDelayMs: Math.round(maxDelay),
    },
    null,
    2,
  ),
)
store.close()
