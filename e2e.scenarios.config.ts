import type { E2EConfig } from 'e2e'
import config from './e2e.real.config.ts'

export default {
  ...config,
  tests: 'tests/e2e/scenarios/*.scenario.ts',
  output: `.e2e/scenario-runs/${Date.now()}-${process.pid}`,
  timeout: 2_100_000,
  actionTimeout: 2_100_000,
} satisfies E2EConfig
