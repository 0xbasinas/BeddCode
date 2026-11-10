import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { HostSettingsStore } from './hostSettings.ts'

const dirs: string[] = []
const file = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'beddcode-settings-'))
  dirs.push(dir)
  return path.join(dir, 'host-settings.json')
}
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs.length = 0
})

describe('HostSettingsStore', () => {
  it('starts empty, persists a patch, and reloads it', () => {
    const pathName = file()
    const store = new HostSettingsStore(pathName)
    expect(store.get().version).toBe(0)
    const first = store.update({ theme: 'light', defaultWorkspace: 'worktree' }, 0, 1_700_000_000_000)
    expect(first.version).toBe(1)
    expect(first.updatedAt).toBe(1_700_000_000_000)
    expect(first.settings.theme).toBe('light')
    expect(first.merged).toBeUndefined()
    const raw = JSON.parse(readFileSync(pathName, 'utf8'))
    expect(raw.settings.theme).toBe('light')
    const reloaded = new HostSettingsStore(pathName)
    expect(reloaded.get().settings.theme).toBe('light')
    expect(reloaded.get().version).toBe(1)
  })

  it('merges a stale write onto newer settings without dropping the other field', () => {
    const store = new HostSettingsStore(file())
    const a = store.update({ theme: 'dark' }, 0, 10)
    expect(a.version).toBe(1)
    const b = store.update({ defaultInstanceId: 'codex' }, 0, 20)
    expect(b.version).toBe(2)
    expect(b.merged).toBe(true)
    expect(b.settings.theme).toBe('dark')
    expect(b.settings.defaultInstanceId).toBe('codex')
  })

  it('notifies other listeners when one client writes', () => {
    const store = new HostSettingsStore(file())
    const seen: number[] = []
    const stop = store.onChange((record) => seen.push(record.version))
    store.update({ autoReview: 'ask' }, 0, 3)
    expect(seen).toEqual([1])
    stop()
    store.update({ autoReview: 'auto' }, 1, 4)
    expect(seen).toEqual([1])
  })

  it('clears a project handoff override and a scalar with null', () => {
    const store = new HostSettingsStore(file())
    store.update(
      {
        theme: 'system',
        handoff: {
          global: { mode: 'ask', fallback: ['claude'], maxHops: 3, cooldownMs: 1 },
          projects: { '/repo': { mode: 'auto', fallback: ['codex'], maxHops: 2, cooldownMs: 1 } },
        },
      },
      0,
      5,
    )
    const next = store.update(
      { theme: null, handoff: { projects: { '/repo': null } } },
      1,
      6,
    )
    expect(next.settings.theme).toBeUndefined()
    expect(next.settings.handoff.projects['/repo']).toBeUndefined()
    expect(next.settings.handoff.global.mode).toBe('ask')
  })
})
