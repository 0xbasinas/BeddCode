import { web } from '@e2e-dev/web'
import type { E2EConfig } from 'e2e'

export default {
  tests: 'tests/e2e/**/*.e2e.ts',
  output: `.e2e/runs/${Date.now()}-${process.pid}`,
  targets: [
    {
      name: 'desktop-web',
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: {
        url: 'http://127.0.0.1:0',
        command: {
          executable: 'node',
          args: ['scripts/e2e-host.mjs', '{port}'],
          log: '.e2e/host.log',
          env: { E2E_TELEMETRY_DISABLED: '1' },
        },
      },
    },
  ],
  workers: 1,
  reporters: ['list', 'junit', 'markdown'],
  trace: 'retain-on-failure',
} satisfies E2EConfig
