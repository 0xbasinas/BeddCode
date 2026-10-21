import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AcpAgentStore } from './config.ts'
import { AcpRegistry, launchFor, type RegistryAgent } from './registry.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-acp-'))
  dirs.push(d)
  return d
}

describe('AcpAgentStore', () => {
  it('starts empty, persists agents, replaces by id, and removes', () => {
    const store = new AcpAgentStore(path.join(tmp(), 'sub', 'agents.json'))
    expect(store.list()).toEqual([])

    store.put({ id: 'goose', label: 'Goose', command: 'goose', args: ['acp'] })
    store.put({ id: 'other', label: 'Other', command: 'o' })
    store.put({ id: 'goose', label: 'Goose 2', command: 'goose', args: ['acp'] })
    expect(store.list().map((a) => [a.id, a.label])).toEqual([
      ['other', 'Other'],
      ['goose', 'Goose 2'],
    ])
    expect(store.get('other')).toMatchObject({ args: [], env: {} })
    expect(store.remove('other')).toBe(true)
    expect(store.remove('other')).toBe(false)
    // A second store over the same file sees the data.
    expect(new AcpAgentStore(path.join(dirs[0]!, 'sub', 'agents.json')).list()).toHaveLength(1)
  })

  it('rejects bad ids and reserved ids', () => {
    const store = new AcpAgentStore(path.join(tmp(), 'a.json'))
    expect(() => store.put({ id: 'Bad Id', label: 'x', command: 'x' })).toThrow()
    expect(() => store.put({ id: 'claude', label: 'x', command: 'x' })).toThrow('reserved')
  })

  it('reports a corrupt file instead of silently dropping agents', () => {
    const file = path.join(tmp(), 'a.json')
    writeFileSync(file, '{ not json')
    expect(() => new AcpAgentStore(file).list()).toThrow('Could not read')
  })
})

const agent = (distribution: RegistryAgent['distribution']): RegistryAgent => ({
  id: 'a',
  name: 'A',
  version: '1',
  description: '',
  distribution,
})

describe('launchFor', () => {
  it('runs npx and uvx packages at the registry version', () => {
    expect(launchFor(agent({ npx: { package: 'p@1', args: ['--acp'] } }))).toEqual({
      ok: true,
      launch: { command: 'npx', args: ['-y', 'p@1', '--acp'], env: {} },
    })
    expect(launchFor(agent({ uvx: { package: 'q==2' } }))).toEqual({
      ok: true,
      launch: { command: 'uvx', args: ['q==2'], env: {} },
    })
  })

  it('reports binary-only agents as unsupported', () => {
    expect(launchFor(agent({ binary: { 'linux-x86_64': {} } }))).toMatchObject({ ok: false })
  })
})

describe('AcpRegistry', () => {
  const payload = {
    agents: [
      {
        id: 'one',
        name: 'One',
        version: '1',
        description: 'First agent',
        distribution: { npx: { package: 'one' } },
      },
      {
        id: 'two',
        name: 'Two',
        version: '1',
        description: 'Second',
        distribution: { uvx: { package: 'two' } },
      },
    ],
  }

  it('caches within the ttl, searches, and falls back to the last copy on failure', async () => {
    let calls = 0
    let fail = false
    let now = 0
    const registry = new AcpRegistry({
      ttlMs: 1000,
      now: () => now,
      fetch: async () => {
        calls++
        if (fail) throw new Error('offline')
        return Response.json(payload)
      },
    })
    expect((await registry.list()).map((a) => a.id)).toEqual(['one', 'two'])
    await registry.list()
    expect(calls).toBe(1)
    expect((await registry.search('second')).map((a) => a.id)).toEqual(['two'])
    expect((await registry.get('one'))?.name).toBe('One')

    now = 5000
    fail = true
    expect((await registry.list()).map((a) => a.id)).toEqual(['one', 'two'])
    expect(calls).toBe(2)
  })

  it('throws when there is no cached copy to fall back to', async () => {
    const registry = new AcpRegistry({ fetch: async () => new Response('nope', { status: 500 }) })
    await expect(registry.list()).rejects.toThrow('500')
  })
})
