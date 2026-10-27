import { defineConfig } from 'vitest/config'

// Settings for a deployed relay (RELAY_URL, RELAY_PASSWORD) live in .env; a variable already set
// in the shell wins, and an empty value counts as unset.
try {
  process.loadEnvFile('.env')
} catch {
  // No .env file: use the local relay.
}
for (const name of ['RELAY_URL', 'RELAY_PASSWORD'])
  if (process.env[name] === '') delete process.env[name]

// Load times over the relay against a direct connection; see docs/e2e.md.
export default defineConfig({
  test: {
    include: ['tests/relay/**/*.test.ts'],
    testTimeout: 300_000,
    hookTimeout: 600_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
