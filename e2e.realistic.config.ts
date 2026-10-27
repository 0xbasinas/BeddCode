import type { E2EConfig } from 'e2e'
import concurrencyConfig from './e2e.concurrent.config.ts'

export default {
  ...concurrencyConfig,
  tests: 'tests/e2e/concurrency/providers.realistic.ts',
  output: `.e2e/realistic-runs/${Date.now()}-${process.pid}`,
} satisfies E2EConfig
