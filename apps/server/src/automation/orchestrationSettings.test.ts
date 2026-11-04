import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationSettingsService } from './orchestrationSettings.ts'

const dirs: string[] = []
function service() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orchestration-'))
  dirs.push(dir)
  return new OrchestrationSettingsService(path.join(dir, 'settings.json'))
}
afterEach(() => {
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('orchestration settings and approvals', () => {
  it('persists global limits and merges project overrides', () => {
    const s = service()
    const settings = s.get()
    settings.global.maxDepth = 4
    settings.global.maxMessagesPerMinute = 7
    settings.projects['/p'] = { maxDepth: 1, maxWorkers: 2, maxMessages: 3 }
    s.set(settings)
    expect(s.forProject('/p')).toEqual({
      maxDepth: 1,
      maxWorkers: 2,
      maxTotalWorkers: 10,
      maxMessagesPerMinute: 7,
      maxMessages: 3,
      approval: 'off',
    })
    expect(s.forProject('/other')).toEqual({
      maxDepth: 4,
      maxWorkers: 5,
      maxTotalWorkers: 10,
      maxMessagesPerMinute: 7,
      maxMessages: 50,
      approval: 'off',
    })
  })
  it('restores pending approvals and expires them after a restart', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(path.join(os.tmpdir(), 'orchestration-'))
    dirs.push(dir)
    const file = path.join(dir, 'settings.json')
    const first = new OrchestrationSettingsService(file)
    const settings = first.get()
    settings.global.approval = 'approve-spawns'
    first.set(settings)
    void first.request('lead', '/p', 'spawn', 'worker')
    first.stop()
    const restored = new OrchestrationSettingsService(file)
    expect(restored.get()).toEqual(settings)
    expect(restored.list()[0]!.status).toBe('pending')
    await vi.advanceTimersByTimeAsync(240_000)
    expect(restored.list()[0]!.status).toBe('expired')
    restored.stop()
  })
  it('waits for approval and persists decisions', async () => {
    const s = service()
    const settings = s.get()
    settings.global.approval = 'approve-spawns-and-messages'
    s.set(settings)
    const allowed = s.request('lead', '/p', 'spawn', 'worker')
    const item = s.list()[0]!
    expect(item.status).toBe('pending')
    expect(s.resolve(item.id, 'approved').status).toBe('approved')
    await expect(allowed).resolves.toBeUndefined()
    const denied = s.request('lead', '/p', 'message', 'hello')
    const rejection = expect(denied).rejects.toThrow('denied')
    s.resolve(s.list()[1]!.id, 'denied')
    await rejection
    expect(s.list().map((a) => a.status)).toEqual(['approved', 'denied'])
    s.stop()
  })
  it('expires a pending request and rejects late decisions', async () => {
    vi.useFakeTimers()
    const s = service()
    const settings = s.get()
    settings.global.approval = 'approve-spawns'
    s.set(settings)
    const pending = s.request('lead', undefined, 'spawn', 'worker')
    const rejection = expect(pending).rejects.toThrow('expired')
    const id = s.list()[0]!.id
    await vi.advanceTimersByTimeAsync(240_000)
    await rejection
    expect(s.list()[0]!.status).toBe('expired')
    expect(() => s.resolve(id, 'approved')).toThrow('Pending approval not found')
    s.stop()
  })
})
