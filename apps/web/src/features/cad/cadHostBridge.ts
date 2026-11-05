/**
 * Bridge between the CAD pane and the host socket.
 *
 * The pane registers providers (`setScreenshotProvider` and the export, query, import, and rebuild
 * setters; pass null to unregister). `takeScreenshot` and the matching `take*` functions answer
 * agent requests. `setCadView` / `getCadView` hold the open document. `setCadPaneOpen` is how the
 * shell says the pane is showing; `getCadOffer` is what the host sends as `cad.view`.
 *
 * Maximize: dispatch `beddcode:cad-maximize` with `{ maximized: boolean }`.
 *
 * Screenshots and Playwright: open the pane with `?cad=1` or `#cad`. Skip the first-run wizard
 * with `localStorage.setItem('beddcode.setup-skipped', '1')` (`skipSetup` in Welcome.tsx).
 * Leave Welcome in place.
 */

export const CAD_MAXIMIZE_EVENT = 'beddcode:cad-maximize'

export interface CadViewState {
  documentId?: string
  selection: string[]
}

export interface CadOffer {
  canRender: boolean
  documentId?: string
  selection: string[]
}

export interface CadImage {
  data: string
  mime: 'image/png'
}

export interface CadRenderRequest {
  documentId: string
  document?: unknown
  featureId?: string
  scale?: number
}

export interface CadQueryRequest {
  documentId: string
  document?: unknown
  featureId?: string
  what?: string
}

export interface CadImportRequest {
  format: string
  data: string
  filename?: string
  documentId?: string
}

export interface CadExportRequest {
  documentId: string
  document?: unknown
  format: string
  featureId?: string
}

export interface CadRebuildRequest {
  documentId: string
  document?: unknown
}

export interface CadFile {
  data: string
  mime: string
  filename?: string
}

export type CadImageSource = string | Uint8Array | CadImage

export type CadExportSource =
  string | Uint8Array | { data: string | Uint8Array; mime?: string; filename?: string }

export type ScreenshotProvider = (
  request: CadRenderRequest,
) => CadImageSource | Promise<CadImageSource>

export type ExportProvider = (
  request: CadExportRequest,
) => CadExportSource | Promise<CadExportSource>

export type QueryProvider = (request: CadQueryRequest) => unknown | Promise<unknown>

export type ImportProvider = (
  request: CadImportRequest,
) =>
  | { features?: unknown[]; sketches?: unknown[]; error?: string }
  | Promise<{ features?: unknown[]; sketches?: unknown[]; error?: string }>

export type RebuildProvider = (
  request: CadRebuildRequest,
) => void | { ok?: boolean; error?: string } | Promise<void | { ok?: boolean; error?: string }>

let screenshotProvider: ScreenshotProvider | null = null
let exportProvider: ExportProvider | null = null
let queryProvider: QueryProvider | null = null
let importProvider: ImportProvider | null = null
let rebuildProvider: RebuildProvider | null = null
let view: CadViewState | null = null
let paneOpen = false
const offerListeners = new Set<() => void>()

function emitOffer() {
  for (const listener of offerListeners) listener()
}

function sameSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}

function sameView(a: CadViewState | null, b: CadViewState | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return a.documentId === b.documentId && sameSelection(a.selection, b.selection)
}

/** `{ maximized: boolean }` from `beddcode:cad-maximize`, or null when the event is not that. */
export function cadMaximizedFromEvent(event: Event): boolean | null {
  if (!('detail' in event)) return null
  const detail = (event as CustomEvent<{ maximized?: unknown }>).detail
  if (!detail || typeof detail !== 'object') return null
  if (typeof detail.maximized !== 'boolean') return null
  return detail.maximized
}

/** The shell calls this when the CAD pane is shown or hidden. */
export function setCadPaneOpen(open: boolean) {
  if (paneOpen === open) return
  paneOpen = open
  emitOffer()
}

/** The pane calls this with the document it has open. Pass null when that document is gone. */
export function setCadView(next: CadViewState | null) {
  const normalized = next ? { documentId: next.documentId, selection: [...next.selection] } : null
  if (sameView(view, normalized)) return
  view = normalized
  if (paneOpen) emitOffer()
}

export function getCadView(): CadViewState | null {
  if (!view) return null
  return { documentId: view.documentId, selection: [...view.selection] }
}

/** What `cad.view` should say right now. */
export function getCadOffer(): CadOffer {
  if (!paneOpen) return { canRender: false, selection: [] }
  const selection = view?.selection ?? []
  if (view?.documentId) return { canRender: true, documentId: view.documentId, selection }
  return { canRender: true, selection }
}

/** Fires when the offer the host should send changes. */
export function subscribeCadOffer(listener: () => void): () => void {
  offerListeners.add(listener)
  return () => {
    offerListeners.delete(listener)
  }
}

/** Registers the pane's screenshot function. Pass null to unregister. */
export function setScreenshotProvider(provider: ScreenshotProvider | null) {
  screenshotProvider = provider
}

/** Registers the pane's export function. Pass null to unregister. */
export function setExportProvider(provider: ExportProvider | null) {
  exportProvider = provider
}

/** Registers the pane's measure function. Pass null to unregister. */
export function setQueryProvider(provider: QueryProvider | null) {
  queryProvider = provider
}

/** Registers the pane's import function. Pass null to unregister. */
export function setImportProvider(provider: ImportProvider | null) {
  importProvider = provider
}

/** Registers the pane's rebuild function. Pass null to unregister. */
export function setRebuildProvider(provider: RebuildProvider | null) {
  rebuildProvider = provider
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, Math.min(index + chunk, bytes.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function pngBase64(source: CadImageSource): string {
  if (source instanceof Uint8Array) {
    if (source.byteLength === 0) throw new Error('The CAD pane did not return a picture.')
    return bytesToBase64(source)
  }
  if (typeof source !== 'string') {
    if (!source.data.trim()) throw new Error('The CAD pane did not return a picture.')
    return pngBase64(source.data)
  }
  const trimmed = source.trim()
  if (!trimmed) throw new Error('The CAD pane did not return a picture.')
  const dataUrl = /^data:image\/png(?:;[^,]*)?;base64,([\sA-Za-z0-9+/=]+)$/i.exec(trimmed)
  if (dataUrl?.[1]) return dataUrl[1].replace(/\s/g, '')
  if (trimmed.startsWith('data:')) {
    throw new Error('Screenshot is not a PNG. Return PNG bytes or a data:image/png URL.')
  }
  return trimmed.replace(/\s/g, '')
}

function renderRequest(request: CadRenderRequest): CadRenderRequest {
  return {
    documentId: request.documentId,
    document: request.document,
    featureId: request.featureId,
    scale: request.scale,
  }
}

/** PNG base64 for `cad.rendered`. Throws when the pane cannot draw. */
export async function takeScreenshot(request: CadRenderRequest): Promise<CadImage> {
  if (!screenshotProvider) throw new Error('Open the CAD pane to take a picture.')
  const source = await screenshotProvider(renderRequest(request))
  return { data: pngBase64(source), mime: 'image/png' }
}

function mimeFor(format: string): string {
  const value = format.trim().toLowerCase()
  if (value === 'step' || value === 'stp') return 'model/step'
  if (value === 'stl') return 'model/stl'
  if (value === 'iges' || value === 'igs') return 'model/iges'
  if (value === 'json') return 'application/json'
  return 'application/octet-stream'
}

function fileBody(source: string | Uint8Array): string {
  if (source instanceof Uint8Array) {
    if (source.byteLength === 0) throw new Error('The CAD pane returned an empty file.')
    return bytesToBase64(source)
  }
  const trimmed = source.trim()
  if (!trimmed) throw new Error('The CAD pane returned an empty file.')
  const dataUrl = /^data:([^,]*),([\s\S]+)$/i.exec(trimmed)
  if (!dataUrl) return trimmed
  const meta = dataUrl[1] ?? ''
  const body = dataUrl[2] ?? ''
  if (/;base64/i.test(meta)) {
    const data = body.replace(/\s/g, '')
    if (!data) throw new Error('The CAD pane returned an empty file.')
    return data
  }
  return bytesToBase64(new TextEncoder().encode(decodeURIComponent(body)))
}

/** File bytes for `cad.exported`. Throws when the pane cannot export. */
export async function takeExport(request: CadExportRequest): Promise<CadFile> {
  if (!exportProvider) throw new Error('Open the CAD pane to export the model.')
  const payload = await exportProvider({
    documentId: request.documentId,
    document: request.document,
    format: request.format,
    featureId: request.featureId,
  })
  if (typeof payload === 'string' || payload instanceof Uint8Array) {
    return { data: fileBody(payload), mime: mimeFor(request.format) }
  }
  if (!payload || payload.data === undefined) throw new Error('The CAD pane returned no file.')
  const filename = payload.filename?.trim()
  return {
    data: fileBody(payload.data),
    mime: payload.mime?.trim() || mimeFor(request.format),
    ...(filename ? { filename } : {}),
  }
}

/** A measurement for `cad.queried`. Throws when the pane cannot measure. */
export async function takeQuery(request: CadQueryRequest): Promise<unknown> {
  if (!queryProvider) throw new Error('Open the CAD pane to measure the model.')
  const geometry = await queryProvider({
    documentId: request.documentId,
    document: request.document,
    featureId: request.featureId,
    what: request.what,
  })
  if (geometry === undefined || geometry === null) {
    throw new Error('The CAD pane returned no measurement.')
  }
  return geometry
}

/** Features for `cad.imported`. Throws when the pane cannot import. */
export async function takeImport(
  request: CadImportRequest,
): Promise<{ features: unknown[]; sketches: unknown[] }> {
  if (!importProvider) throw new Error('Open the CAD pane to import a file.')
  const result = await importProvider({
    format: request.format,
    data: request.data,
    filename: request.filename,
    documentId: request.documentId,
  })
  if (!result || typeof result !== 'object') throw new Error('The CAD pane returned no features.')
  if (!result.features && !result.sketches) {
    throw new Error(result.error || 'The CAD pane returned no features.')
  }
  return { features: result.features ?? [], sketches: result.sketches ?? [] }
}

/** Rebuilds for `cad.rebuilt`. Throws when the pane cannot rebuild. */
export async function takeRebuild(request: CadRebuildRequest): Promise<void> {
  if (!rebuildProvider) throw new Error('Open the CAD pane to rebuild the model.')
  const result = await rebuildProvider({
    documentId: request.documentId,
    document: request.document,
  })
  if (result && typeof result === 'object' && (result.ok === false || result.error)) {
    throw new Error(result.error || 'The CAD pane could not rebuild the model.')
  }
}
