import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { ProjectStore } from './projects.ts'
import type { GitService } from './git.ts'

it('migrates old project storage and preserves overrides across other writes', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'project-backend-'))
  try {
    const file = path.join(dir, 'projects.json')
    writeFileSync(file, JSON.stringify({ version: 1, paths: [dir] }))
    const git = { info: async () => ({ isRepo: false }) } as unknown as GitService
    const store = new ProjectStore(file, git)
    expect(store.backendFor(dir)).toBeUndefined()
    await store.setClaudeBackend(dir, 'cli')
    await store.setScripts(dir, [{ id: 'a', name: 'a', command: 'true' }])
    expect(store.backendFor(dir)).toBe('cli')
    expect(JSON.parse(readFileSync(file, 'utf8')).backends[dir]).toBe('cli')
    await store.setClaudeBackend(dir, null)
    expect(store.backendFor(dir)).toBeUndefined()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
