import type { E2EConfig } from 'e2e'
import realConfig from './e2e.real.config.ts'

export default {
  ...realConfig,
  tests: 'tests/e2e/concurrency/providers.load.ts',
  output: `.e2e/concurrency-runs/${Date.now()}-${process.pid}`,
  timeout: 240_000,
  actionTimeout: 200_000,
} satisfies E2EConfig
