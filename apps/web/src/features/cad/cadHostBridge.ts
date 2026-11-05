/**
 * Host bridge for the CAD pane.
 *
 * CadPane registers providers while it is mounted. `stores/host.ts` answers
 * `cad.render`, `cad.export`, `cad.query`, `cad.rebuild`, and `cad.import`
 * by calling `takeScreenshot`, `takeExport`, `takeQuery`, `takeRebuild`, and
 * `takeImport`, then sending `cad.rendered` / `cad.exported` / `cad.queried` /
 * `cad.rebuilt` / `cad.imported`.
 *
 * `getCadView()` is the offer for `HostClient.offerCad` (`canRender`, `documentId`, `selection`).
 * The pane also calls `reportCadView` so the offer is sent as soon as the pane is open.
 *
 * Maximize is a window event, not a host frame: `beddcode:cad-maximize` with
 * detail `{ maximized: boolean }`. The shell toggles `.right.cad-open.cad-maximized`.
 */

export const CAD_MAXIMIZE_EVENT = 'beddcode:cad-maximize'

export interface CadMaximizeDetail {
  maximized: boolean
}

export function cadMaximizeDetail(maximized: boolean): CadMaximizeDetail {
  return { maximized: maximized === true }
}

/** Tells the shell to grow or shrink the CAD column. Returns the payload it sent. */
export function emitCadMaximize(
  maximized: boolean,
  target: EventTarget | null = typeof window === 'undefined' ? null : window,
): CadMaximizeDetail {
  const detail = cadMaximizeDetail(maximized)
  target?.dispatchEvent(new CustomEvent(CAD_MAXIMIZE_EVENT, { detail }))
  return detail
}

/** Reads `{ maximized }` from a `beddcode:cad-maximize` event. */
export function cadMaximizedFromEvent(event: Event): boolean | null {
  if (!('detail' in event)) return null
  const detail = (event as CustomEvent<{ maximized?: unknown }>).detail
  if (!detail || typeof detail !== 'object') return null
  if (typeof detail.maximized !== 'boolean') return null
  return detail.maximized
}

/**
 * The shell calls this when the CAD pane is shown or hidden.
 * Closing clears the offer so agents stop asking for screenshots.
 */
export function setCadPaneOpen(open: boolean): void {
  if (open) return
  setCadView({ canRender: false, selection: [] })
}

export interface CadViewOffer {
  canRender: boolean
  documentId?: string
  selection: string[]
}

export interface CadImage {
  data: string
  mime: 'image/png'
}

export interface CadExportRequest {
  documentId: string
  document?: unknown
  format: string
  featureId?: string
}

export interface CadExportFile {
  data: string
  mime: string
  filename?: string
}

export interface CadQueryRequest {
  documentId: string
  document?: unknown
  featureId?: string
  what?: string
}

export interface CadRebuildRequest {
  documentId: string
  document?: unknown
}

export interface CadImportRequest {
  format: string
  data: string
  filename?: string
  documentId?: string
}

export interface CadImportResult {
  features: unknown[]
  sketches: unknown[]
}

type ScreenshotProvider = () => string | Promise<string>
type ExportProvider = (
  request: CadExportRequest,
) => CadExportFile | Uint8Array | string | Promise<CadExportFile | Uint8Array | string>
type QueryProvider = (request: CadQueryRequest) => unknown | Promise<unknown>
type RebuildProvider = (request: CadRebuildRequest) => void | Promise<void>
type ImportProvider = (request: CadImportRequest) => CadImportResult | Promise<CadImportResult>

let screenshotProvider: ScreenshotProvider | null = null
let exportProvider: ExportProvider | null = null
let queryProvider: QueryProvider | null = null
let rebuildProvider: RebuildProvider | null = null
let importProvider: ImportProvider | null = null
let cadView: CadViewOffer = { canRender: false, selection: [] }

export function setCadView(next: CadViewOffer): void {
  cadView = {
    canRender: next.canRender,
    ...(next.documentId ? { documentId: next.documentId } : {}),
    selection: next.selection ?? [],
  }
}

export function getCadView(): CadViewOffer {
  return cadView
}

export function setScreenshotProvider(provider: ScreenshotProvider | null): void {
  screenshotProvider = provider
}

export function registerCadScreenshotProvider(provider: ScreenshotProvider): () => void {
  screenshotProvider = provider
  return () => {
    if (screenshotProvider === provider) screenshotProvider = null
  }
}

export function setExportProvider(provider: ExportProvider | null): void {
  exportProvider = provider
}

export function registerCadExportProvider(provider: ExportProvider): () => void {
  exportProvider = provider
  return () => {
    if (exportProvider === provider) exportProvider = null
  }
}

export function setQueryProvider(provider: QueryProvider | null): void {
  queryProvider = provider
}

export function registerCadQueryProvider(provider: QueryProvider): () => void {
  queryProvider = provider
  return () => {
    if (queryProvider === provider) queryProvider = null
  }
}

export function setRebuildProvider(provider: RebuildProvider | null): void {
  rebuildProvider = provider
}

export function registerCadRebuildProvider(provider: RebuildProvider): () => void {
  rebuildProvider = provider
  return () => {
    if (rebuildProvider === provider) rebuildProvider = null
  }
}

export function setImportProvider(provider: ImportProvider | null): void {
  importProvider = provider
}

export function registerCadImportProvider(provider: ImportProvider): () => void {
  importProvider = provider
  return () => {
    if (importProvider === provider) importProvider = null
  }
}

/** PNG data URL or raw base64 from the viewport, as the base64 payload `cad.rendered` sends. */
export function pngFromSource(source: string): CadImage {
  const trimmed = source.trim()
  if (!trimmed) throw new Error('The CAD pane has no picture yet.')
  const match = /^data:image\/png(?:;[^,]*)?;base64,([A-Za-z0-9+/=\s]+)$/i.exec(trimmed)
  if (match) {
    const data = (match[1] ?? '').replace(/\s/g, '')
    if (!data) throw new Error('The CAD pane has no picture yet.')
    return { data, mime: 'image/png' }
  }
  if (/^data:/i.test(trimmed)) throw new Error('The CAD picture was not a PNG.')
  return { data: trimmed.replace(/\s/g, ''), mime: 'image/png' }
}

export async function takeScreenshot(): Promise<CadImage> {
  if (!screenshotProvider) throw new Error('The CAD pane is not open.')
  return pngFromSource(await screenshotProvider())
}

function mimeFor(format: string): { mime: string; filename: string } {
  const kind = format.trim().toLowerCase()
  if (kind === 'step' || kind === 'stp') return { mime: 'application/step', filename: 'part.step' }
  if (kind === 'stl') return { mime: 'model/stl', filename: 'part.stl' }
  if (kind === 'json') return { mime: 'application/json', filename: 'part.cad.json' }
  return { mime: 'application/octet-stream', filename: 'part.bin' }
}

export function encodeBytes(bytes: Uint8Array): string {
  const chunk = 0x8000
  let binary = ''
  for (let index = 0; index < bytes.length; index += chunk) {
    const slice = bytes.subarray(index, index + chunk)
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function asExportFile(raw: CadExportFile | Uint8Array | string, format: string): CadExportFile {
  const fallback = mimeFor(format)
  if (typeof raw === 'string') {
    const image = /^data:/i.test(raw) ? pngFromSource(raw) : null
    if (image) return { data: image.data, mime: image.mime, filename: fallback.filename }
    const data = encodeBytes(new TextEncoder().encode(raw))
    if (!data) throw new Error('The CAD pane returned an empty export.')
    return { data, mime: fallback.mime, filename: fallback.filename }
  }
  if (raw instanceof Uint8Array) {
    if (raw.byteLength === 0) throw new Error('The CAD pane returned an empty export.')
    return { data: encodeBytes(raw), mime: fallback.mime, filename: fallback.filename }
  }
  if (!raw.data) throw new Error('The CAD pane returned an empty export.')
  return {
    data: raw.data,
    mime: raw.mime || fallback.mime,
    ...(raw.filename ? { filename: raw.filename } : { filename: fallback.filename }),
  }
}

export async function takeExport(request: CadExportRequest): Promise<CadExportFile> {
  if (!exportProvider) throw new Error('The CAD pane cannot export yet.')
  return asExportFile(await exportProvider(request), request.format)
}

export async function takeQuery(request: CadQueryRequest): Promise<unknown> {
  if (!queryProvider) throw new Error('The CAD pane cannot measure yet.')
  const geometry = await queryProvider(request)
  if (geometry === undefined || geometry === null)
    throw new Error('The CAD pane returned no measurement.')
  return geometry
}

export async function takeRebuild(request: CadRebuildRequest): Promise<void> {
  if (!rebuildProvider) throw new Error('The CAD pane is not open.')
  await rebuildProvider(request)
}

export async function takeImport(request: CadImportRequest): Promise<CadImportResult> {
  if (!importProvider) throw new Error('The CAD pane cannot import yet.')
  const result = await importProvider(request)
  return {
    features: result.features ?? [],
    sketches: result.sketches ?? [],
  }
}

/** File bytes from base64, or from the original text when it is not base64. */
export function decodeTransferBytes(data: string): Uint8Array {
  const compact = data.trim().replace(/\s/g, '')
  if (compact.length > 0 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    const binary = atob(compact)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
    return bytes
  }
  return new TextEncoder().encode(data)
}

export function decodeTransferText(data: string): string {
  const trimmed = data.trim()
  if (trimmed.startsWith('{') || trimmed.startsWith('ISO-10303') || trimmed.startsWith('solid ')) {
    return trimmed
  }
  try {
    const text = new TextDecoder().decode(decodeTransferBytes(trimmed)).trim()
    if (text.startsWith('{') || text.startsWith('ISO-10303') || text.startsWith('solid '))
      return text
  } catch {
    // Keep the original text when the payload is not base64.
  }
  return trimmed
}

/** Clears providers. Tests use this so one case cannot answer another. */
export function resetCadHostBridge(): void {
  screenshotProvider = null
  exportProvider = null
  queryProvider = null
  rebuildProvider = null
  importProvider = null
  cadView = { canRender: false, selection: [] }
}
