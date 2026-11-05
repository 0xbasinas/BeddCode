import { describe, expect, it } from 'vitest'
import type { ServerFrame } from '@beddcode/contracts'
import { CadLink, NEEDS_CAD_PANE } from './cadLink.ts'

/** Eight-byte PNG signature, the smallest thing this link treats as a PNG. */
const PNG = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)

describe('CAD link', () => {
  it('turns a screenshot provider into a PNG and forgets it on unsubscribe', async () => {
    const link = new CadLink()
    expect((await link.render({ documentId: 'd1' })).ok).toBe(false)

    const stop = link.registerScreenshot(async () => PNG)
    const shot = await link.render({ documentId: 'd1', scale: 1 })
    expect(shot).toEqual({
      ok: true,
      image: { data: Buffer.from(PNG).toString('base64'), mime: 'image/png' },
    })
    stop()
    const gone = await link.render({ documentId: 'd1' })
    expect(gone).toMatchObject({ ok: false, error: NEEDS_CAD_PANE })

    link.registerScreenshot(
      async () => `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`,
    )
    expect((await link.render({ documentId: 'd1' })).ok).toBe(true)
    link.registerScreenshot(() => Uint8Array.of(0, 1, 2, 3, 4, 5, 6, 7))
    expect(await link.render({ documentId: 'd1' })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/not a PNG/),
    })
  })

  it('asks a pane to export, stores bytes, and prefers a live pane over stored bytes', async () => {
    const link = new CadLink()
    const missing = await link.requestExport('stl', { documentId: 'd1' })
    expect(missing).toEqual({ ok: false, error: NEEDS_CAD_PANE })

    link.registerExport(Uint8Array.of(1, 2, 3), {
      format: 'stp',
      documentId: 'd1',
      filename: 'a.step',
    })
    expect(await link.requestExport('step', { documentId: 'd1' })).toEqual({
      ok: true,
      file: {
        data: Buffer.from([1, 2, 3]).toString('base64'),
        mime: 'model/step',
        filename: 'a.step',
      },
    })

    const sent: ServerFrame[] = []
    const client = link.connect((frame) => sent.push(frame))
    client.frame({ t: 'cad.view', canRender: true, documentId: 'd1' })
    const pending = link.requestExport('stl', { documentId: 'd1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const asked = sent.find((frame) => frame.t === 'cad.export') as Extract<
      ServerFrame,
      { t: 'cad.export' }
    >
    expect(asked.format).toBe('stl')
    expect(asked.documentId).toBe('d1')
    client.frame({
      t: 'cad.exported',
      id: asked.id,
      file: { data: 'U1RM', mime: 'model/stl', filename: 'live.stl' },
    })
    expect(await pending).toEqual({
      ok: true,
      file: { data: 'U1RM', mime: 'model/stl', filename: 'live.stl' },
    })

    sent.length = 0
    const stop = link.registerExport(async (request) => {
      expect(request.format).toBe('stl')
      return new Uint8Array([9])
    })
    const handled = await link.requestExport('stl', { documentId: 'd1' })
    expect(handled).toEqual({
      ok: true,
      file: { data: Buffer.from([9]).toString('base64'), mime: 'model/stl' },
    })
    expect(sent.some((frame) => frame.t === 'cad.export')).toBe(false)
    stop()
  })

  it('times out when the export handler does not answer', async () => {
    const link = new CadLink()
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    link.registerExport(async () => {
      await gate
      return new Uint8Array([1])
    })
    const result = await link.requestExport('stl', { documentId: 'd1' }, 30)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/export the CAD model/)
    release()
  })

  it('asks a pane to import, and reports when none is connected', async () => {
    const link = new CadLink()
    expect(
      await link.requestImport({ format: 'step', data: 'ISO-10303-21;', documentId: 'd1' }),
    ).toEqual({ ok: false, error: NEEDS_CAD_PANE })

    const stop = link.registerImport(async (request) => ({
      features: [{ type: 'import', name: request.filename ?? 'File' }],
      sketches: [],
    }))
    expect(await link.requestImport({ format: 'iges', data: 'iges', filename: 'arm.igs' })).toEqual(
      {
        ok: true,
        features: [{ type: 'import', name: 'arm.igs' }],
        sketches: [],
      },
    )
    stop()

    const sent: ServerFrame[] = []
    const client = link.connect((frame) => sent.push(frame))
    client.frame({ t: 'cad.view', canRender: true })
    const pending = link.requestImport({ format: 'stl', data: 'solid', documentId: 'd1' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    const asked = sent.find((frame) => frame.t === 'cad.import') as Extract<
      ServerFrame,
      { t: 'cad.import' }
    >
    expect(asked.format).toBe('stl')
    client.frame({
      t: 'cad.imported',
      id: asked.id,
      features: [{ type: 'import' }],
      sketches: [],
    })
    expect((await pending).ok).toBe(true)
  })

  it('measures and rebuilds through pane handlers', async () => {
    const link = new CadLink()
    const stopQuery = link.registerQuery(async (request) => ({ what: request.what, volume: 4 }))
    expect(await link.query({ documentId: 'd1', what: 'volume' })).toEqual({
      ok: true,
      geometry: { what: 'volume', volume: 4 },
    })
    stopQuery()
    expect((await link.query({ documentId: 'd1', what: 'volume' })).ok).toBe(false)

    const seen: unknown[] = []
    link.registerRebuild(async (request) => {
      seen.push(request.document)
    })
    expect(await link.rebuild({ documentId: 'd1', document: { name: 'Arm' } })).toEqual({
      ok: true,
    })
    expect(seen).toEqual([{ name: 'Arm' }])
  })

  it('publishes document changes to in-process panes', () => {
    const link = new CadLink()
    const heard: string[] = []
    const stop = link.onChange((change) => heard.push(change.id))
    link.publish({ id: 'doc-1', rev: 2, origin: 'agent', touched: ['box-1'] })
    stop()
    link.publish({ id: 'doc-2', rev: 1 })
    expect(heard).toEqual(['doc-1'])
  })
})
