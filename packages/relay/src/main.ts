#!/usr/bin/env -S npx tsx
import { startRelay } from './node.ts'

/** Runs a relay for self-hosting: `PORT=8787 pnpm --filter @beddcode/relay start`. Put TLS in front (Caddy, nginx). */
const port = Number(process.env.PORT ?? 8787)
const relay = await startRelay({
  port,
  host: process.env.HOST,
  hostPassword: process.env.RELAY_PASSWORD || undefined,
  log: (m) => console.log(`[relay] ${m}`),
})
const stop = () => void relay.close().then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
