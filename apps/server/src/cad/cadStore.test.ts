import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { CadStore, type CadChange, type CadDocument } from './cadStore.ts'

let dir: string
let store: CadStore
let changes: CadChange[]

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cad-'))
  store = new CadStore(dir)
  changes = []
  store.onChange((c) => changes.push(c))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('CAD store', () => {
  it('creates an empty millimetre document and lists it', () => {
    const doc = store.create('Bracket')
    expect(doc).toMatchObject({
      name: 'Bracket',
      rev: 1,
      units: 'mm',
      features: [],
      sketches: [],
      params: {},
      historyIndex: 0,
    })
    expect(doc.id).toMatch(/^[\w-]{1,64}$/)
    expect(store.list()).toEqual([
      { id: doc.id, name: 'Bracket', rev: 1, updatedAt: doc.updatedAt },
    ])
    expect(changes.at(-1)).toMatchObject({ id: doc.id, rev: 1 })
  })

  it('lists the newest document first and skips files that are not documents', () => {
    const older = store.create('Older')
    const newer = store.create('Newer')
    writeFileSync(path.join(dir, 'bad.json'), '{')
    writeFileSync(path.join(dir, 'nope.json'), JSON.stringify({ name: 1 }))
    const listed = store.list()
    expect(listed.map((d) => d.id)).toContain(older.id)
    expect(listed.map((d) => d.id)).toContain(newer.id)
    expect(listed).toHaveLength(2)
    expect(listed[0]!.updatedAt).toBeGreaterThanOrEqual(listed[1]!.updatedAt)
    expect(store.list()).toHaveLength(2)
  })

  it('bumps rev on each save, tells listeners, and reloads from disk', () => {
    const doc = store.create('Plate')
    const saved = store.mutate(
      doc.id,
      (draft) => {
        draft.features.push({
          id: 'box-1',
          type: 'box',
          name: 'Box',
          params: { width: 10, depth: 20, height: 5 },
        })
        draft.historyIndex = 1
        draft.params.width = 10
      },
      'agent',
      ['box-1'],
    )
    expect(saved).toMatchObject({ id: doc.id, name: 'Plate', rev: 2 })
    expect(changes.at(-1)).toEqual({ id: doc.id, rev: 2, origin: 'agent', touched: ['box-1'] })
    const reopened = new CadStore(dir)
    expect(reopened.get(doc.id)).toMatchObject({
      name: 'Plate',
      rev: 2,
      units: 'mm',
      historyIndex: 1,
      params: { width: 10 },
    })
    expect(reopened.get(doc.id)!.features).toHaveLength(1)
  })

  it('keeps the history cursor inside the feature list and forces millimetres', () => {
    const doc = store.create('Clip')
    store.save(doc.id, {
      ...doc,
      units: 'in' as CadDocument['units'],
      historyIndex: 9,
      features: [{ id: 'box-1', type: 'box', name: 'Box', params: {} }],
    })
    expect(store.get(doc.id)).toMatchObject({ units: 'mm', historyIndex: 1 })
  })

  it('rejects unsafe ids and a missing document', () => {
    expect(store.get('../etc/passwd')).toBeUndefined()
    expect(() => store.save('../etc/passwd', {} as CadDocument)).toThrow(/No CAD document/)
    expect(store.remove('../etc/passwd')).toBe(false)
    expect(store.remove('missing')).toBe(false)
    const doc = store.create('Gone')
    expect(store.remove(doc.id)).toBe(true)
    expect(store.get(doc.id)).toBeUndefined()
  })
})
