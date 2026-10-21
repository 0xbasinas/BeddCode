import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Several tests drive real `git`, which is slow to spawn on Windows.
  test: { testTimeout: 30_000, hookTimeout: 30_000 },
})
