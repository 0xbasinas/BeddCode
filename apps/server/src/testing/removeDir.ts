import { rmSync } from 'node:fs'

/**
 * Removes a test's temp folder. A git process the test started may still be working in it, and
 * Windows will not delete a folder something is using, so this tries again for a few seconds.
 */
export async function removeDir(dir: string, waitMs = 10_000): Promise<void> {
  const end = Date.now() + waitMs
  for (;;) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch (err) {
      if (Date.now() > end) throw err
      await new Promise((r) => setTimeout(r, 100))
    }
  }
}
