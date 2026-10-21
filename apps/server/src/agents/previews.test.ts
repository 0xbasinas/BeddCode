import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentPreview } from '@beddcode/contracts'
import { PreviewCache } from './previews.ts'

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
