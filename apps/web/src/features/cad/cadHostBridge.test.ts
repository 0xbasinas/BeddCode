import { afterEach, describe, expect, it } from 'vitest'
import {
  CAD_MAXIMIZE_EVENT,
  cadMaximizedFromEvent,
  getCadOffer,
  getCadView,
  setCadPaneOpen,
  setCadView,
  setExportProvider,
  setImportProvider,
  setQueryProvider,
  setRebuildProvider,
  setScreenshotProvider,
  subscribeCadOffer,
  takeExport,
  takeImport,
  takeQuery,
  takeRebuild,
  takeScreenshot,
} from './cadHostBridge.ts'

afterEach(() => {
  setScreenshotProvider(null)
  setExportProvider(null)
  setQueryProvider(null)
  setImportProvider(null)
  setRebuildProvider(null)
  setCadView(null)
  setCadPaneOpen(false)
})

describe('cad host bridge', () => {
  it('reads the maximize event', () => {
    expect(CAD_MAXIMIZE_EVENT).toBe('beddcode:cad-maximize')
    expect(
      cadMaximizedFromEvent(new CustomEvent(CAD_MAXIMIZE_EVENT, { detail: { maximized: true } })),
    ).toBe(true)
    expect(
      cadMaximizedFromEvent(new CustomEvent(CAD_MAXIMIZE_EVENT, { detail: { maximized: false } })),
    ).toBe(false)
    expect(cadMaximizedFromEvent(new CustomEvent(CAD_MAXIMIZE_EVENT, { detail: {} }))).toBeNull()
    expect(cadMaximizedFromEvent(new Event('click'))).toBeNull()
  })

  it('registers and unregisters a screenshot provider', async () => {
    await expect(takeScreenshot({ documentId: 'd1' })).rejects.toThrow(/open the CAD pane/i)
    setScreenshotProvider(() => 'data:image/png;base64,aaaa')
    await expect(takeScreenshot({ documentId: 'd1' })).resolves.toEqual({
      data: 'aaaa',
      mime: 'image/png',
    })
    setScreenshotProvider(async () => ({ data: 'bbbb', mime: 'image/png' }))
    await expect(takeScreenshot({ documentId: 'd1', scale: 1 })).resolves.toEqual({
      data: 'bbbb',
      mime: 'image/png',
    })
    setScreenshotProvider(null)
    await expect(takeScreenshot({ documentId: 'd1' })).rejects.toThrow(/open the CAD pane/i)
  })

  it('rejects a picture that is not a png', async () => {
    setScreenshotProvider(() => '')
    await expect(takeScreenshot({ documentId: 'd1' })).rejects.toThrow(/picture/i)
    setScreenshotProvider(() => 'data:image/jpeg;base64,aaaa')
    await expect(takeScreenshot({ documentId: 'd1' })).rejects.toThrow(/png/i)
  })

  it('registers and unregisters export, query, import, and rebuild', async () => {
    await expect(takeExport({ documentId: 'd1', format: 'step' })).rejects.toThrow(/export/i)
    setExportProvider(() => ({ data: 'U1RFUA==', mime: 'model/step', filename: 'part.step' }))
    await expect(takeExport({ documentId: 'd1', format: 'step' })).resolves.toEqual({
      data: 'U1RFUA==',
      mime: 'model/step',
      filename: 'part.step',
    })
    setExportProvider(null)
    await expect(takeExport({ documentId: 'd1', format: 'stl' })).rejects.toThrow(/export/i)

    setQueryProvider(() => ({ distance: 4 }))
    await expect(takeQuery({ documentId: 'd1', what: 'distance' })).resolves.toEqual({
      distance: 4,
    })
    setQueryProvider(() => null)
    await expect(takeQuery({ documentId: 'd1' })).rejects.toThrow(/measurement/i)
    setQueryProvider(null)
    await expect(takeQuery({ documentId: 'd1' })).rejects.toThrow(/measure/i)

    setImportProvider(() => ({ features: [{ id: 'f1' }], sketches: [] }))
    await expect(takeImport({ format: 'step', data: 'U1RFUA==' })).resolves.toEqual({
      features: [{ id: 'f1' }],
      sketches: [],
    })
    setImportProvider(() => ({ error: 'bad step' }))
    await expect(takeImport({ format: 'step', data: 'AA==' })).rejects.toThrow(/bad step/)
    setImportProvider(null)

    setRebuildProvider(() => undefined)
    await expect(takeRebuild({ documentId: 'd1' })).resolves.toBeUndefined()
    setRebuildProvider(() => ({ ok: false, error: 'broken sketch' }))
    await expect(takeRebuild({ documentId: 'd1' })).rejects.toThrow(/broken sketch/)
    setRebuildProvider(null)
    await expect(takeRebuild({ documentId: 'd1' })).rejects.toThrow(/rebuild/i)
  })

  it('offers cad only while the pane is open and keeps the document id', () => {
    expect(getCadOffer()).toEqual({ canRender: false, selection: [] })
    const seen: boolean[] = []
    const stop = subscribeCadOffer(() => seen.push(getCadOffer().canRender))
    setCadView({ documentId: 'part-1', selection: ['edge-2'] })
    expect(getCadView()).toEqual({ documentId: 'part-1', selection: ['edge-2'] })
    expect(getCadOffer().canRender).toBe(false)
    setCadPaneOpen(true)
    expect(getCadOffer()).toEqual({
      canRender: true,
      documentId: 'part-1',
      selection: ['edge-2'],
    })
    setCadView({ documentId: 'part-1', selection: ['edge-2'] })
    setCadPaneOpen(false)
    expect(getCadOffer()).toEqual({ canRender: false, selection: [] })
    expect(getCadView()?.documentId).toBe('part-1')
    expect(seen).toEqual([true, false])
    stop()
    setCadPaneOpen(true)
    expect(seen).toEqual([true, false])
  })
})
