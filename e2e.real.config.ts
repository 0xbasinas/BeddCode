import { web } from '@e2e-dev/web'
import type { E2EConfig } from 'e2e'

// Separate config makes real provider calls an explicit opt-in.
export default {
  tests: 'tests/e2e/real/*.live.ts',
  output: `.e2e/real-runs/${Date.now()}-${process.pid}`,
  targets: [
    {
      name: 'desktop-web-real',
      engine: web({ viewport: { width: 1440, height: 900 } }),
      app: {
        url: 'http://127.0.0.1:0',
        command: {
          executable: 'node',
          args: ['scripts/e2e-host.mjs', '{port}', '--real-agents'],
          log: '.e2e/real-host.log',
          inheritEnv: [
            'USERPROFILE',
            'APPDATA',
            'LOCALAPPDATA',
            'CODEX_HOME',
            'CLAUDE_CONFIG_DIR',
            'GROK_*',
            'SYSTEMROOT',
            'COMSPEC',
          ],
        },
      },
    },
  ],
  workers: 1,
  timeout: 180_000,
  retries: 0,
  reporters: ['list', 'junit', 'markdown'],
  trace: 'retain-on-failure',
} satisfies E2EConfig
