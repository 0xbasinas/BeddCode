import { afterEach, describe, expect, it } from 'vitest'
import {
  CAD_MAXIMIZE_EVENT,
  cadMaximizeDetail,
  decodeTransferText,
  emitCadMaximize,
  getCadView,
  pngFromSource,
  registerCadExportProvider,
  registerCadScreenshotProvider,
  resetCadHostBridge,
  setCadView,
  takeExport,
  takeScreenshot,
} from './cadHostBridge.ts'

afterEach(() => {
  resetCadHostBridge()
})

describe('cad host bridge', () => {
  it('builds the maximize payload the shell listens for', () => {
    expect(cadMaximizeDetail(true)).toEqual({ maximized: true })
    expect(cadMaximizeDetail(false)).toEqual({ maximized: false })
    const target = new EventTarget()
    let detail: unknown
    target.addEventListener(CAD_MAXIMIZE_EVENT, (event) => {
      detail = (event as CustomEvent).detail
    })
    emitCadMaximize(true, target)
    expect(detail).toEqual({ maximized: true })
  })

  it('registers a screenshot provider and strips the PNG data URL', async () => {
    expect(getCadView()).toEqual({ canRender: false, selection: [] })
    setCadView({ canRender: true, documentId: 'part', selection: ['box'] })
    expect(getCadView()).toEqual({ canRender: true, documentId: 'part', selection: ['box'] })

    const stop = registerCadScreenshotProvider(() => 'data:image/png;base64,iVBORw0KGgo=')
    await expect(takeScreenshot()).resolves.toEqual({ data: 'iVBORw0KGgo=', mime: 'image/png' })
    stop()
    await expect(takeScreenshot()).rejects.toThrow(/not open/)
    expect(pngFromSource('aaaa')).toEqual({ data: 'aaaa', mime: 'image/png' })
    expect(() => pngFromSource('')).toThrow(/no picture/)
    expect(() => pngFromSource('data:image/jpeg;base64,aa')).toThrow(/not a PNG/)
  })

  it('encodes an export from the registered provider', async () => {
    const stop = registerCadExportProvider(async (request) => {
      if (request.format === 'step') return new Uint8Array([1, 2, 3])
      return '{"name":"Part"}'
    })
    const step = await takeExport({ documentId: 'part', format: 'step' })
    expect(step.mime).toBe('application/step')
    expect(step.filename).toBe('part.step')
    expect(step.data).toBe(btoa('\x01\x02\x03'))
    const json = await takeExport({ documentId: 'part', format: 'json' })
    expect(json.mime).toBe('application/json')
    expect(atob(json.data)).toBe('{"name":"Part"}')
    stop()
    await expect(takeExport({ documentId: 'part', format: 'stl' })).rejects.toThrow(/cannot export/)
  })

  it('reads JSON that arrived as text or base64', () => {
    expect(decodeTransferText('{"id":"a"}')).toBe('{"id":"a"}')
    expect(decodeTransferText(btoa('{"id":"a"}'))).toBe('{"id":"a"}')
  })
})
