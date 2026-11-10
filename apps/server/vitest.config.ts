import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Several tests drive real `git`, which is slow to spawn on Windows.
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // These suites spawn git, PowerShell and real hosts. Unbounded workers can starve
    // process inspection and make live-process checks time out on Windows.
    ...(process.platform === 'win32' ? { maxWorkers: 4 } : {}),
  },
})
