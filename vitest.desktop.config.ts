import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Real agents use provider quota, so they run only through `pnpm test:desktop:real`.
    include: ['tests/desktop/**/*.desktop.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})
