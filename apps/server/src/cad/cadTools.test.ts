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

  it('returns a real PNG from a screenshot provider and nothing once it is gone', async () => {
    // Minimal PNG signature. The pane may return bytes or a data URL.
    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    const data = Buffer.from(png).toString('base64')
    run('cad_add_feature', { type: 'box', params: { width: 10, depth: 4, height: 6 } })
    let scale = 0
    const stop = link.registerScreenshot(async (request) => {
      scale = request.scale ?? 0
      return png
    })
    const shot = await tools.callAsync('cad_screenshot', { scale: 5 })
    expect(shot.isError).toBeUndefined()
    expect(scale).toBe(2)
    expect(shot.content[1]).toEqual({ type: 'image', data, mimeType: 'image/png' })
    stop()
    link.registerScreenshot(async () => `data:image/png;base64,${data}`)
    const fromUrl = await tools.callAsync('cad_screenshot', {})
    expect(fromUrl.content[1]).toEqual({ type: 'image', data, mimeType: 'image/png' })
    link.registerScreenshot(async () => Uint8Array.of(1, 2, 3, 4))
    const rejected = await tools.callAsync('cad_screenshot', {})
    expect(rejected.isError).toBe(true)
    expect((rejected.content[0] as { text: string }).text).toMatch(/not a PNG/)
  })

  it('tells the link when a tool changes a document, and rebuilds through a pane handler', async () => {
    const heard: { id: string; rev: number; touched?: string[] }[] = []
    link.onChange((change) => heard.push(change))
    const rebuilt: string[] = []
    link.registerRebuild(async (request) => {
      rebuilt.push(request.documentId)
      const doc = request.document as { features: { type: string }[] }
      expect(doc.features.map((feature) => feature.type)).toEqual(['box'])
    })
    const created = run('cad_create', { name: 'Arm' })
    expect(heard.at(-1)).toMatchObject({ id: created.json.id, rev: 1, origin: 'agent' })
    const pending = tools.callAsync('cad_add_feature', {
      document: created.json.id,
      type: 'box',
      params: { width: 2, depth: 2, height: 2 },
    })
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(JSON.parse((result.content[0] as { text: string }).text).rebuildStatus).toBeUndefined()
    expect(rebuilt).toEqual([created.json.id])
    expect(heard.some((change) => change.touched?.length === 1 && change.rev === 2)).toBe(true)
  })

  it('exports JSON on the host and STEP through the pane or stored bytes', async () => {
    const created = run('cad_create', { name: 'Plate' })
    run('cad_add_feature', {
      document: created.json.id,
      type: 'box',
      params: { width: 4, depth: 5, height: 6 },
    })
    const json = await tools.callAsync('cad_export', { document: created.json.id, format: 'json' })
    expect(json.isError).toBeUndefined()
    const body = JSON.parse((json.content[0] as { text: string }).text)
    expect(body).toMatchObject({
      format: 'json',
      mime: 'application/json',
      filename: 'plate.cad.json',
      encoding: 'utf-8',
    })
    expect(JSON.parse(body.data).features).toHaveLength(1)

    const missing = await tools.callAsync('cad_export', {
      document: created.json.id,
      format: 'step',
    })
    expect(missing.isError).toBe(true)
    expect(JSON.parse((missing.content[0] as { text: string }).text)).toMatchObject({
      needsPane: true,
      action: 'export',
      format: 'step',
      document: created.json.id,
    })

    const bytes = Uint8Array.of(0x73, 0x74, 0x6c)
    link.registerExport(bytes, {
      documentId: created.json.id,
      format: 'step',
      filename: 'plate.step',
    })
    const stored = await tools.callAsync('cad_export', { document: created.json.id, format: 'stp' })
    expect(JSON.parse((stored.content[0] as { text: string }).text)).toMatchObject({
      format: 'stp',
      filename: 'plate.step',
      mime: 'model/step',
      data: Buffer.from(bytes).toString('base64'),
    })

    link.registerExport(async (request) => {
      expect(request.format).toBe('stl')
      expect(request.documentId).toBe(created.json.id)
      return { data: 'U1RM', mime: 'model/stl', filename: 'plate.stl' }
    })
    const live = await tools.callAsync('cad_export', { document: created.json.id, format: 'stl' })
    expect(JSON.parse((live.content[0] as { text: string }).text)).toMatchObject({
      format: 'stl',
      filename: 'plate.stl',
      data: 'U1RM',
    })
  })

  it('imports JSON on the host and OCCT files through a pane handler', async () => {
    const created = run('cad_create', { name: 'Empty' })
    const pending = tools.callAsync('cad_import', {
      document: created.json.id,
      format: 'json',
      data: JSON.stringify({
        sketches: [{ id: 'sk-1', name: 'Profile', plane: 'XY', entities: [] }],
        features: [
          { id: 'box-kept', type: 'box', name: 'Kept', params: { width: 2, depth: 3, height: 4 } },
          { id: 'cyl-1', kind: 'cylinder', name: 'Pin', params: { radius: 1, height: 2 } },
        ],
      }),
    })
    const imported = JSON.parse(((await pending).content[0] as { text: string }).text)
    expect(imported.features).toEqual(['box-kept', 'cyl-1'])
    expect(imported.sketches).toEqual(['sk-1'])
    const tree = run('cad_get_tree', { document: created.json.id }).json
    expect(tree.features.map((feature: { name: string }) => feature.name)).toEqual(['Kept', 'Pin'])

    link.registerImport(async (request) => {
      expect(request.format).toBe('stl')
      return {
        features: [{ type: 'import', name: 'Mesh', params: { format: 'stl' } }],
        sketches: [],
      }
    })
    link.registerRebuild(async () => {})
    const occt = await tools.callAsync('cad_import', {
      document: created.json.id,
      format: 'stl',
      data: 'solid mesh',
    })
    expect(occt.isError).toBeUndefined()
    expect(run('cad_get_tree', { document: created.json.id }).json.features).toHaveLength(3)
  })

  it('uses a pane measurement, and otherwise estimates a bbox from parameters', async () => {
    run('cad_add_feature', { type: 'box', params: { width: 10, depth: 20, height: 8 } })
    const estimated = JSON.parse(
      (
        (await tools.callAsync('cad_query_geometry', { what: 'bbox' })).content[0] as {
          text: string
        }
      ).text,
    )
    expect(estimated.accuracy).toBe('approximate')
    expect(estimated.source).toBe('feature-params')
    expect(estimated.geometry).toEqual({ min: [-5, -10, 0], max: [5, 10, 8] })
    expect((await tools.callAsync('cad_query_geometry', { what: 'volume' })).isError).toBe(true)
    expect((await tools.callAsync('cad_query_geometry', { what: 'area' })).isError).toBe(true)

    const shifted = run('cad_add_feature', {
      type: 'cylinder',
      params: { radius: 2, height: 5, x: 10 },
    })
    const cylinder = JSON.parse(
      (
        (
          await tools.callAsync('cad_query_geometry', {
            feature: shifted.json.feature,
            what: 'bbox',
          })
        ).content[0] as { text: string }
      ).text,
    )
    expect(cylinder.geometry).toEqual({ min: [8, -2, 0], max: [12, 2, 5] })
    expect(cylinder.accuracy).toBe('approximate')

    link.registerQuery(async (request) => {
      expect(request.what).toBe('volume')
      return { volume: 113.1 }
    })
    const measured = JSON.parse(
      (
        (await tools.callAsync('cad_query_geometry', { what: 'volume' })).content[0] as {
          text: string
        }
      ).text,
    )
    expect(measured.geometry).toEqual({ volume: 113.1 })
    expect(measured.accuracy).toBeUndefined()
  })

  it('estimates an extrude and skips a suppressed feature', async () => {
    const sketch = run('cad_add_sketch', {
      plane: 'YZ',
      entities: [{ type: 'rect', width: 20, height: 10 }],
    })
    run('cad_add_feature', {
      type: 'extrude',
      sketch: sketch.json.sketch,
      params: { distance: 8 },
    })
    const extruded = JSON.parse(
      (
        (await tools.callAsync('cad_query_geometry', { what: 'bbox' })).content[0] as {
          text: string
        }
      ).text,
    )
    expect(extruded.geometry).toEqual({ min: [0, -10, -5], max: [8, 10, 5] })

    const box = run('cad_add_feature', { type: 'sphere', params: { radius: 3 } })
    run('cad_edit_feature', { id: box.json.feature, suppressed: true })
    // The extrude is still active. The suppressed sphere must not widen the box.
    const whole = JSON.parse(
      (
        (await tools.callAsync('cad_query_geometry', { what: 'bbox' })).content[0] as {
          text: string
        }
      ).text,
    )
    expect(whole.geometry).toEqual({ min: [0, -10, -5], max: [8, 10, 5] })
  })

  it('stores a box at its exact size, a boss, a hole at a point, and fillet edges', async () => {
    const box = run('cad_add_feature', {
      type: 'box',
      name: 'Plate',
      params: { width: 40, depth: 20, height: 10 },
    })
    expect(box.error).toBe(false)
    const docId = box.json.document as string
    expect(run('cad_get_tree', { document: docId }).json.features[0].params).toEqual({
      width: 40,
      depth: 20,
      height: 10,
    })

    const sketch = run('cad_add_sketch', {
      document: docId,
      plane: 'XY',
      entities: [{ type: 'rect', width: 30, height: 16 }],
    })
    const boss = run('cad_add_feature', {
      document: docId,
      type: 'extrude',
      name: 'Boss',
      sketch: sketch.json.sketch,
      params: { distance: 12 },
    })
    expect(boss.error).toBe(false)
    expect(boss.json).toMatchObject({ type: 'extrude' })

    const face = run('cad_add_feature', {
      document: docId,
      type: 'hole',
      params: {
        targetId: box.json.feature,
        plane: 'XY',
        x: 6,
        y: -3,
        diameter: 5,
      },
    })
    expect(face.error).toBe(false)
    const world = run('cad_add_feature', {
      document: docId,
      type: 'hole',
      params: {
        targetId: box.json.feature,
        point: [1, 2, 10],
        diameter: 4,
      },
    })
    expect(world.error).toBe(false)

    const ref = { kind: 'edge', mid: [1, 0, 5], dir: [0, 0, 1], length: 10 }
    const fillet = run('cad_add_feature', {
      document: docId,
      type: 'fillet',
      params: {
        targetId: box.json.feature,
        radius: 4,
        edgeIds: [11, 4],
        edgeRefs: [ref],
      },
    })
    expect(fillet.error).toBe(false)
    // The same edges as a comma list and a JSON string, which is how the pane stores them.
    expect(
      run('cad_edit_feature', {
        document: docId,
        id: fillet.json.feature,
        params: { edgeIds: '11, 4', edgeRefs: JSON.stringify([ref]) },
      }).error,
    ).toBe(false)

    const saved = store.get(docId)!
    expect(saved.sketches[0]!.entities[0]).toMatchObject({ type: 'rect', kind: 'rect' })
    expect(saved.features.map((feature) => feature.type)).toEqual([
      'box',
      'extrude',
      'hole',
      'hole',
      'fillet',
    ])
    expect(saved.features.every((feature) => feature.kind === feature.type)).toBe(true)
    expect(saved.features.every((feature) => feature.suppressed === false)).toBe(true)
    expect(saved.features[0]!.params).toEqual({ width: 40, depth: 20, height: 10 })
    expect(saved.features[1]!.params).toEqual({ distance: 12 })
    expect(saved.features[1]!.sketchId).toBe(sketch.json.sketch)
    expect(saved.features[2]!.params).toEqual({
      target: box.json.feature,
      targetId: box.json.feature,
      x: 6,
      y: -3,
      z: 10,
      diameter: 5,
      throughAll: true,
      direction: '-Z',
    })
    expect(saved.features[3]!.params).toEqual({
      target: box.json.feature,
      targetId: box.json.feature,
      x: 1,
      y: 2,
      z: 10,
      diameter: 4,
      throughAll: true,
    })
    expect(saved.features[4]!.params).toMatchObject({
      target: box.json.feature,
      targetId: box.json.feature,
      radius: 4,
      edgeIds: '11,4',
    })
    expect(JSON.parse(String(saved.features[4]!.params.edgeRefs))).toEqual([ref])

    const measured = JSON.parse(
      (
        (await tools.callAsync('cad_query_geometry', { document: docId, what: 'bbox' }))
          .content[0] as {
          text: string
        }
      ).text,
    )
    expect(measured.geometry).toEqual({ min: [-20, -10, 0], max: [20, 10, 12] })
    expect(measured.accuracy).toBe('approximate')
    const plate = JSON.parse(
      (
        (
          await tools.callAsync('cad_query_geometry', {
            document: docId,
            feature: box.json.feature,
            what: 'bbox',
          })
        ).content[0] as { text: string }
      ).text,
    )
    expect(plate.geometry).toEqual({ min: [-20, -10, 0], max: [20, 10, 10] })

    const png = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
    link.registerScreenshot(async (request) => {
      expect(request.documentId).toBe(docId)
      const body = request.document as { features: { type: string; kind?: string }[] }
      expect(body.features.map((feature) => feature.kind)).toEqual([
        'box',
        'extrude',
        'hole',
        'hole',
        'fillet',
      ])
      return png
    })
    const shot = await tools.callAsync('cad_screenshot', { document: docId })
    expect(shot.isError).toBeUndefined()
    expect(shot.content[1]).toEqual({
      type: 'image',
      data: Buffer.from(png).toString('base64'),
      mimeType: 'image/png',
    })
  })

  it('places a hole on the YZ face from plane x and y', () => {
    const box = run('cad_add_feature', {
      type: 'box',
      params: { width: 40, depth: 20, height: 10 },
    })
    const hole = run('cad_add_feature', {
      type: 'hole',
      params: { targetId: box.json.feature, plane: 'YZ', x: 1, y: 4, diameter: 3 },
    })
    expect(hole.error).toBe(false)
    const saved = store.get(hole.json.document as string)!.features[1]!
    expect(saved.params).toMatchObject({
      x: 20,
      y: 1,
      z: 4,
      direction: '-X',
      diameter: 3,
      throughAll: true,
    })
  })

  it('rejects a hole with no point and a fillet with bad edges', () => {
    const box = run('cad_add_feature', {
      type: 'box',
      params: { width: 10, depth: 10, height: 4 },
    })
    const docId = box.json.document as string
    expect(
      run('cad_add_feature', { document: docId, type: 'hole', params: { x: 1, y: 2 } }).text,
    ).toMatch(/targetId/)
    expect(
      run('cad_add_feature', {
        document: docId,
        type: 'hole',
        params: { targetId: box.json.feature },
      }).text,
    ).toMatch(/face plane|world point/)
    expect(
      run('cad_add_feature', {
        document: docId,
        type: 'hole',
        params: { targetId: 'missing', x: 0, y: 0 },
      }).text,
    ).toMatch(/No feature missing/)
    expect(
      run('cad_add_feature', {
        document: docId,
        type: 'hole',
        params: { targetId: box.json.feature, plane: 'AB', x: 0, y: 0 },
      }).text,
    ).toMatch(/unknown hole plane/)
    expect(
      run('cad_add_feature', {
        document: docId,
        type: 'fillet',
        params: { radius: 0, edgeIds: [1] },
      }).text,
    ).toMatch(/radius must be a positive number/)
    expect(
      run('cad_add_feature', {
        document: docId,
        type: 'fillet',
        params: { radius: 4, targetId: box.json.feature, edgeIds: [11, -2] },
      }).text,
    ).toMatch(/edgeIds/)
    expect(
      run('cad_add_feature', {
        document: docId,
        type: 'fillet',
        params: { radius: 4, edgeRefs: [{ kind: 'face' }] },
      }).text,
    ).toMatch(/edgeRefs/)
  })
})
