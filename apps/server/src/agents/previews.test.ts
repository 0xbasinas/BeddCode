import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentPreview, SessionEvent } from '@beddcode/contracts'
import { PreviewCache, PreviewSeeds } from './previews.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const file = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-previews-'))
  dirs.push(d)
  return path.join(d, 'previews.json')
}
const preview: AgentPreview = {
  modes: [{ id: 'ask', label: 'Ask' }],
  config: [],
  commands: [{ name: 'web' }],
}

describe('PreviewCache', () => {
  it('remembers what an agent offered, across restarts', () => {
    const f = file()
    new PreviewCache(f).set('acp:grok', preview)
    expect(new PreviewCache(f).get('acp:grok')).toEqual(preview)
    expect(new PreviewCache(f).get('acp:other')).toBeUndefined()
  })

  it('drops answers kept by an older version of the app', () => {
    const f = file()
    writeFileSync(f, JSON.stringify({ 'acp:grok': { at: Date.now(), preview } }))
    expect(new PreviewCache(f).get('acp:grok')).toBeUndefined()
  })

  it('lets old answers expire, and forgets on request', () => {
    let now = 0
    const cache = new PreviewCache(undefined, () => now)
    cache.set('a', preview)
    cache.set('b', preview)
    now = 6 * 24 * 60 * 60_000
    expect(cache.get('a')).toEqual(preview)
    now = 8 * 24 * 60 * 60_000
    expect(cache.get('a')).toBeUndefined()
    now = 0
    cache.set('c', preview)
    cache.clear('c')
    expect(cache.get('c')).toBeUndefined()
    cache.clearAll()
    expect(cache.get('b')).toBeUndefined()
  })

  it('starts empty when its file is missing or damaged', () => {
    expect(new PreviewCache(file()).get('x')).toBeUndefined()
    const f = file()
    new PreviewCache(f).set('x', preview)
    writeFileSync(f, 'not json')
    expect(new PreviewCache(f).get('x')).toBeUndefined()
  })
})

describe('PreviewSeeds', () => {
  const at = { sessionId: 's1', at: 1 }
  const config = (value: string): SessionEvent => ({
    ...at,
    type: 'session.config',
    options: [{ id: 'model', name: 'Model', type: 'select', value, choices: [] }],
  })
  const turn: SessionEvent = { ...at, type: 'turn.started' }

  it("takes the agent's defaults from a new session's first settings, not the user's later choice", () => {
    const seeds = new PreviewSeeds()
    expect(seeds.observe('s1', config('grok-4.7'), () => true)).toBeUndefined()
    // The model the user picked on the new-session screen, applied before the first turn.
    seeds.observe('s1', config('grok-4.6'), () => true)
    seeds.observe(
      's1',
      { ...at, type: 'session.commands', commands: [{ name: 'compact' }] },
      () => true,
    )
    const preview = seeds.observe('s1', turn, () => true)
    expect(preview?.config[0]?.value).toBe('grok-4.7')
    expect(preview?.commands).toEqual([{ name: 'compact' }])
    // Later turns never overwrite it.
    seeds.observe('s1', config('grok-4.5'), () => false)
    expect(seeds.observe('s1', turn, () => false)).toBeUndefined()
  })

  it('ignores resumed sessions, whose settings are what the user left them at', () => {
    const seeds = new PreviewSeeds()
    seeds.observe('s2', { ...config('grok-4.6'), sessionId: 's2' }, () => false)
    expect(seeds.observe('s2', { ...turn, sessionId: 's2' }, () => false)).toBeUndefined()
  })

  it('replaces a stale cached preview', () => {
    const cache = new PreviewCache()
    cache.set('acp:grok', { ...preview, config: [] })
    const seeds = new PreviewSeeds()
    seeds.observe('s1', config('grok-4.7'), () => true)
    cache.set(
      'acp:grok',
      seeds.observe('s1', turn, () => true)!,
    )
    expect(cache.get('acp:grok')?.config[0]?.value).toBe('grok-4.7')
  })
})

describe('PreviewCache.ageOf', () => {
  it('says how old an answer is, so an old one can be refreshed in the background', () => {
    let now = 1_000
    const cache = new PreviewCache(undefined, () => now)
    expect(cache.ageOf('acp:grok')).toBeUndefined()
    cache.set('acp:grok', preview)
    now = 61_000
    expect(cache.ageOf('acp:grok')).toBe(60_000)
  })
})
