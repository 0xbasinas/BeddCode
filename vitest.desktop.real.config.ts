import { defineConfig } from 'vitest/config'

// Real agent CLIs use provider quota, so they have their own config and script.
export default defineConfig({
  test: {
    include: ['tests/desktop/**/*.real.test.ts'],
    testTimeout: 600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
