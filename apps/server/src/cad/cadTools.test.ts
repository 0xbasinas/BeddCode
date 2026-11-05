import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerFrame } from '@beddcode/contracts'
import { CadStore, type CadChange } from './cadStore.ts'
import { CadLink } from './cadLink.ts'
import { CadTools, isCadToolName } from './cadTools.ts'

let dir: string
let store: CadStore
let tools: CadTools
let link: CadLink
let changes: CadChange[]

const run = (tool: Parameters<CadTools['call']>[0], args: Record<string, unknown> = {}) => {
  const r = tools.call(tool, args)
  const first = r.content[0]!
  const text = first.type === 'text' ? first.text : ''
  return {
    error: r.isError === true,
    text,
    json: r.isError
      ? undefined
      : (() => {
          try {
            return JSON.parse(text)
          } catch {
            return undefined
          }
        })(),
  }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cad-tools-'))
  store = new CadStore(dir)
  link = new CadLink()
  tools = new CadTools(store, link)
  changes = []
  store.onChange((c) => changes.push(c))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('CAD tools', () => {
  it('names every CAD tool', () => {
    expect(isCadToolName('cad_add_feature')).toBe(true)
    expect(isCadToolName('design_add')).toBe(false)
  })

  it('creates a document, lists it, and reads an empty tree', () => {
    const created = run('cad_create', { name: 'Bracket' })
    expect(created.error).toBe(false)
    expect(created.json).toMatchObject({ name: 'Bracket', units: 'mm' })
    expect(run('cad_list').json.documents.map((d: { id: string }) => d.id)).toEqual([
      created.json.id,
    ])
    expect(run('cad_get_tree').json).toMatchObject({
      document: created.json.id,
      units: 'mm',
      historyIndex: 0,
      sketches: [],
      features: [],
    })
  })

  it('adds a sketch and a feature, then edits, retargets history, and deletes', () => {
    const sketch = run('cad_add_sketch', {
      plane: 'XY',
      entities: [{ type: 'rect', width: 20, height: 10 }],
    })
    expect(sketch.error).toBe(false)
    const feature = run('cad_add_feature', {
      type: 'extrude',
      name: 'Pad',
      sketch: sketch.json.sketch,
      params: { distance: 8 },
    })
    expect(feature.json).toMatchObject({ type: 'extrude', historyIndex: 1 })
    const second = run('cad_add_feature', {
      type: 'box',
      params: { width: 4, depth: 4, height: 4 },
    })
    const docId = feature.json.document as string
    store.mutate(docId, (doc) => {
      doc.historyIndex = 1
    })
    const third = run('cad_add_feature', {
      document: docId,
      type: 'fillet',
      params: { radius: 1 },
    })
    const tree = run('cad_get_tree', { document: docId }).json
    expect(tree.features.map((f: { type: string }) => f.type)).toEqual(['extrude', 'fillet'])
    expect(tree.historyIndex).toBe(2)
    expect(tree.features[0]).toMatchObject({
      name: 'Pad',
      active: true,
      sketchId: sketch.json.sketch,
    })
    expect(second.json.feature).not.toBe(third.json.feature)

    expect(
      run('cad_edit_feature', {
        id: feature.json.feature,
        name: 'Boss',
        params: { distance: 12, note: null },
      }).error,
    ).toBe(false)
    expect(run('cad_get_tree').json.features[0]).toMatchObject({
      name: 'Boss',
      params: { distance: 12 },
    })
    expect(run('cad_edit_feature', { id: feature.json.feature, type: 'box' }).text).toMatch(
      /cannot be changed/,
    )
    expect(run('cad_delete_feature', { id: third.json.feature }).json.removed).toBe(
      third.json.feature,
    )
    expect(run('cad_get_tree').json.historyIndex).toBe(1)
    expect(
      changes.some((c) => c.origin === 'agent' && c.touched?.includes(feature.json.feature)),
    ).toBe(true)
  })

  it('merges document parameters and drops a null key', () => {
    run('cad_set_params', { params: { width: 30, label: 'a' } })
    const next = run('cad_set_params', { params: { width: 40, label: null } })
    expect(next.json.params).toEqual({ width: 40 })
    expect(run('cad_set_params', { params: [] }).error).toBe(true)
  })

  it('refuses a feature the kernel does not know and a missing id', () => {
    expect(run('cad_add_feature', { type: 'banana' }).text).toMatch(/Unknown feature type/)
    expect(run('cad_add_feature', { type: 'extrude', sketch: 'missing' }).text).toMatch(/No sketch/)
    expect(run('cad_edit_feature', { id: 'ghost' }).text).toMatch(/No feature ghost/)
    expect(run('cad_delete_feature', { id: 'ghost' }).text).toMatch(/No feature ghost/)
    expect(run('cad_get_tree', { document: 'nope' }).text).toMatch(/No CAD document nope/)
  })

  it('persists across store instances', () => {
    const id = run('cad_create', { name: 'Plate' }).json.id as string
    run('cad_add_feature', { document: id, type: 'box', params: { width: 1, depth: 2, height: 3 } })
    const reopened = new CadStore(dir)
    expect(reopened.get(id)).toMatchObject({ name: 'Plate', rev: 2, historyIndex: 1 })
  })

  it('reports that geometry was not rebuilt when no pane is open', async () => {
    const result = await tools.callAsync('cad_add_feature', {
      type: 'box',
      params: { width: 10, depth: 10, height: 10 },
    })
    expect(result.isError).not.toBe(true)
    expect(JSON.parse((result.content[0] as { text: string }).text).rebuildStatus).toMatch(
      /Needs an open CAD pane/,
    )
  })

  it('asks a connected pane to rebuild after an edit', async () => {
    const sent: ServerFrame[] = []
    const client = link.connect((f) => sent.push(f))
    client.frame({ t: 'cad.view', canRender: true })
    const pending = tools.callAsync('cad_add_feature', {
      type: 'cylinder',
      params: { radius: 2, height: 5 },
    })
    await new Promise((r) => setTimeout(r, 0))
    const asked = sent.find((f) => f.t === 'cad.rebuild') as Extract<
      ServerFrame,
      { t: 'cad.rebuild' }
    >
    expect(asked.documentId).toBeTruthy()
    client.frame({ t: 'cad.rebuilt', id: asked.id })
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(JSON.parse((result.content[0] as { text: string }).text).rebuildStatus).toBeUndefined()
  })

  it('returns a picture, a measurement, and an export from a connected pane', async () => {
    run('cad_add_feature', { type: 'sphere', params: { radius: 3 } })
    expect((await tools.callAsync('cad_screenshot', {})).content[0]).toMatchObject({
      text: expect.stringMatching(/Needs an open CAD pane/),
    })
    expect((await tools.callAsync('cad_query_geometry', { what: 'volume' })).isError).toBe(true)
    expect((await tools.callAsync('cad_export', { format: 'stl' })).isError).toBe(true)

    const sent: ServerFrame[] = []
    const client = link.connect((f) => sent.push(f))
    client.frame({ t: 'cad.view', canRender: true })

    const shot = tools.callAsync('cad_screenshot', { scale: 5 })
    await new Promise((r) => setTimeout(r, 0))
    const render = sent.find((f) => f.t === 'cad.render') as Extract<
      ServerFrame,
      { t: 'cad.render' }
    >
    expect(render.scale).toBe(2)
    client.frame({
      t: 'cad.rendered',
      id: render.id,
      image: { data: 'QUJD', mime: 'image/png' },
    })
    const pictured = await shot
    expect(pictured.content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' })

    const measure = tools.callAsync('cad_query_geometry', { what: 'volume' })
    await new Promise((r) => setTimeout(r, 0))
    const query = sent.find((f) => f.t === 'cad.query') as Extract<ServerFrame, { t: 'cad.query' }>
    client.frame({ t: 'cad.queried', id: query.id, geometry: { volume: 12.5 } })
    expect(JSON.parse(((await measure).content[0] as { text: string }).text).geometry).toEqual({
      volume: 12.5,
    })

    const exported = tools.callAsync('cad_export', { format: 'step' })
    await new Promise((r) => setTimeout(r, 0))
    const exp = sent.find((f) => f.t === 'cad.export') as Extract<ServerFrame, { t: 'cad.export' }>
    expect(exp.format).toBe('step')
    client.frame({
      t: 'cad.exported',
      id: exp.id,
      file: { data: 'U1RFUA==', mime: 'model/step', filename: 'part.step' },
    })
    expect(JSON.parse(((await exported).content[0] as { text: string }).text)).toMatchObject({
      format: 'step',
      filename: 'part.step',
      data: 'U1RFUA==',
    })
  })

  it('imports features through a connected pane', async () => {
    const sent: ServerFrame[] = []
    const client = link.connect((f) => sent.push(f))
    client.frame({ t: 'cad.view', canRender: true })
    const pending = tools.callAsync('cad_import', {
      format: 'step',
      filename: 'bracket.step',
      data: 'ISO-10303-21;',
    })
    await new Promise((r) => setTimeout(r, 0))
    const asked = sent.find((f) => f.t === 'cad.import') as Extract<
      ServerFrame,
      { t: 'cad.import' }
    >
    expect(asked.format).toBe('step')
    client.frame({
      t: 'cad.imported',
      id: asked.id,
      features: [{ type: 'import', name: 'Bracket', params: { format: 'step' } }],
      sketches: [],
    })
    await new Promise((r) => setTimeout(r, 0))
    const rebuild = sent.find((f) => f.t === 'cad.rebuild') as Extract<
      ServerFrame,
      { t: 'cad.rebuild' }
    >
    client.frame({ t: 'cad.rebuilt', id: rebuild.id })
    const result = await pending
    expect(result.isError).toBeUndefined()
    const body = JSON.parse((result.content[0] as { text: string }).text)
    expect(body.features).toHaveLength(1)
    expect(run('cad_get_tree').json.features[0]).toMatchObject({ type: 'import', name: 'Bracket' })
  })
})
