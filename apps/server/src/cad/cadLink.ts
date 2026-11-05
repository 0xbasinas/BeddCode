import type { ClientFrame, ServerFrame } from '@beddcode/contracts'

type ViewFrame = Extract<ClientFrame, { t: 'cad.view' }>
type RenderedFrame = Extract<ClientFrame, { t: 'cad.rendered' }>
type QueriedFrame = Extract<ClientFrame, { t: 'cad.queried' }>
type ImportedFrame = Extract<ClientFrame, { t: 'cad.imported' }>
type ExportedFrame = Extract<ClientFrame, { t: 'cad.exported' }>
type RebuiltFrame = Extract<ClientFrame, { t: 'cad.rebuilt' }>
type InFrame =
  ViewFrame | RenderedFrame | QueriedFrame | ImportedFrame | ExportedFrame | RebuiltFrame

export interface CadView {
  documentId?: string
  selection: string[]
}

export type RenderResult =
  { ok: true; image: { data: string; mime: string } } | { ok: false; error: string }
export type QueryResult = { ok: true; geometry: unknown } | { ok: false; error: string }
export type ImportResult =
  { ok: true; features: unknown[]; sketches: unknown[] } | { ok: false; error: string }
export type ExportResult =
  | { ok: true; file: { data: string; mime: string; filename?: string } }
  | { ok: false; error: string }
export type RebuildResult = { ok: true } | { ok: false; error: string }
type Answer = RenderResult | QueryResult | ImportResult | ExportResult | RebuildResult

/** Same notice the host sends as `cad.changed`, for an in-process pane. */
export interface CadPaneNotice {
  id: string
  rev: number
  origin?: string
  touched?: string[]
}

export interface ScreenshotRequest {
  documentId: string
  document?: unknown
  featureId?: string
  scale?: number
}

/** PNG bytes, a `data:image/png` URL, or base64 of a PNG. */
export type ScreenshotSource = Uint8Array | string
export type ScreenshotProvider = (
  request: ScreenshotRequest,
) => ScreenshotSource | Promise<ScreenshotSource>

export interface ExportRequest {
  documentId: string
  document?: unknown
  format: string
  featureId?: string
}

export type ExportPayload =
  Uint8Array | string | { data: Uint8Array | string; mime?: string; filename?: string }

export type ExportProvider = (request: ExportRequest) => ExportPayload | Promise<ExportPayload>

export interface ExportBytesMeta {
  format: string
  documentId?: string
  featureId?: string
  mime?: string
  filename?: string
}

export interface ImportRequest {
  format: string
  data: string
  filename?: string
  documentId?: string
}

export type ImportProvider = (
  request: ImportRequest,
) =>
  | { features?: unknown[]; sketches?: unknown[]; error?: string }
  | Promise<{ features?: unknown[]; sketches?: unknown[]; error?: string }>

export interface QueryRequest {
  documentId: string
  document?: unknown
  featureId?: string
  what?: string
}

export type QueryProvider = (request: QueryRequest) => unknown | Promise<unknown>

export interface RebuildRequest {
  documentId: string
  document?: unknown
}

export type RebuildProvider = (
  request: RebuildRequest,
) => void | { ok?: boolean; error?: string } | Promise<void | { ok?: boolean; error?: string }>

const RENDER_TIMEOUT_MS = 20_000
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/** Shown when no connected app can draw the model. Tools surface this as their error. */
export const NEEDS_CAD_PANE =
  'Needs an open CAD pane with a renderer. No BeddCode app that can draw CAD models is connected to this host. Ask the user to open the CAD pane and try again.'

interface Client {
  id: number
  send(frame: ServerFrame): void
  canRender: boolean
  view: CadView
  /** When the view last changed, epoch ms. */
  at: number
}

interface Pending {
  clients: Set<number>
  resolve(result: Answer): void
  timer: ReturnType<typeof setTimeout>
}

interface StoredExport {
  format: string
  documentId?: string
  featureId?: string
  mime: string
  filename?: string
  data: string
}

/**
 * The connected apps that can draw CAD models for agents, what each has open in the CAD pane, and
 * the pictures and measurements asked of them. Like the design link: the agent's tool waits here.
 * A pane in this process can also register handlers; those answer before the WebSocket clients.
 */
export class CadLink {
  private readonly clients = new Map<number, Client>()
  private readonly pending = new Map<string, Pending>()
  private readonly changeListeners = new Set<(change: CadPaneNotice) => void>()
  private readonly storedExports: StoredExport[] = []
  private screenshotProvider?: ScreenshotProvider
  private exportProvider?: ExportProvider
  private importProvider?: ImportProvider
  private queryProvider?: QueryProvider
  private rebuildProvider?: RebuildProvider
  private nextClient = 1
  private nextCall = 1

  /** A new WebSocket connection; it takes part once it says it can render. */
  connect(send: (frame: ServerFrame) => void) {
    const client: Client = {
      id: this.nextClient++,
      send,
      canRender: false,
      view: { selection: [] },
      at: 0,
    }
    return {
      frame: (frame: InFrame) => {
        if (frame.t === 'cad.view') {
          client.canRender = frame.canRender
          client.view = {
            documentId: frame.documentId,
            selection: frame.selection ?? [],
          }
          client.at = Date.now()
          this.clients.set(client.id, client)
          return
        }
        const p = this.pending.get(frame.id)
        if (!p || !p.clients.has(client.id)) return
        const result = this.read(frame)
        if (!result) {
          p.clients.delete(client.id)
          if (p.clients.size > 0) return
        }
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        p.resolve(result ?? { ok: false, error: frame.error ?? 'The app could not do this.' })
      },
      close: () => {
        this.clients.delete(client.id)
        for (const [id, p] of this.pending) {
          if (!p.clients.delete(client.id) || p.clients.size > 0) continue
          this.pending.delete(id)
          clearTimeout(p.timer)
          p.resolve({ ok: false, error: 'The app that was drawing the CAD model disconnected.' })
        }
      },
    }
  }

  /** A successful answer, or nothing when this client could not do it. */
  private read(frame: Exclude<InFrame, ViewFrame>): Answer | undefined {
    if (frame.t === 'cad.rendered' && frame.image) return { ok: true, image: frame.image }
    if (frame.t === 'cad.queried' && frame.geometry !== undefined)
      return { ok: true, geometry: frame.geometry }
    if (frame.t === 'cad.imported' && (frame.features || frame.sketches))
      return { ok: true, features: frame.features ?? [], sketches: frame.sketches ?? [] }
    if (frame.t === 'cad.exported' && frame.file) return { ok: true, file: frame.file }
    if (frame.t === 'cad.rebuilt' && !frame.error) return { ok: true }
    return undefined
  }

  /** What the user looked at last in a CAD pane, if one is open. */
  current(): CadView | undefined {
    const open = [...this.clients.values()]
      .filter((c) => c.view.documentId)
      .sort((a, b) => b.at - a.at)[0]
    return open?.view
  }

  /**
   * In-process panes subscribe to the same document notices the host sends as `cad.changed`.
   * Returns the function that unsubscribes.
   */
  onChange(listener: (change: CadPaneNotice) => void): () => void {
    this.changeListeners.add(listener)
    return () => void this.changeListeners.delete(listener)
  }

  /** Tells in-process panes that a document changed, so they rebuild that same document. */
  publish(change: CadPaneNotice): void {
    for (const listener of this.changeListeners) listener(change)
  }

  /**
   * The pane registers how to take a PNG of the open model.
   * `provider` returns PNG bytes, a `data:image/png` URL, or base64 of a PNG.
   * Returns the function that removes this provider.
   */
  registerScreenshot(provider: ScreenshotProvider): () => void {
    this.screenshotProvider = provider
    return () => {
      if (this.screenshotProvider === provider) this.screenshotProvider = undefined
    }
  }

  /**
   * Registers who answers `requestExport`, or stores bytes the pane already wrote.
   * A handler is used while the pane is open. Stored bytes are the fallback when it is not.
   */
  registerExport(provider: ExportProvider): () => void
  registerExport(bytes: Uint8Array | string, meta: ExportBytesMeta): void
  registerExport(
    providerOrBytes: ExportProvider | Uint8Array | string,
    meta?: ExportBytesMeta,
  ): (() => void) | void {
    if (typeof providerOrBytes === 'function') {
      this.exportProvider = providerOrBytes
      return () => {
        if (this.exportProvider === providerOrBytes) this.exportProvider = undefined
      }
    }
    if (typeof providerOrBytes !== 'string' && !(providerOrBytes instanceof Uint8Array)) {
      throw new Error('registerExport expects a handler or file bytes')
    }
    if (!meta || typeof meta.format !== 'string' || !meta.format.trim()) {
      throw new Error('format is required')
    }
    const format = canonicalFormat(meta.format)
    const data = fileData(providerOrBytes)
    if (!data) throw new Error('export bytes are empty')
    const entry: StoredExport = {
      format,
      documentId: meta.documentId,
      featureId: meta.featureId,
      mime: meta.mime?.trim() || mimeFor(format),
      ...(meta.filename ? { filename: meta.filename.slice(0, 200) } : {}),
      data,
    }
    this.storedExports.splice(
      0,
      this.storedExports.length,
      entry,
      ...this.storedExports
        .filter(
          (item) =>
            !(
              item.format === format &&
              item.documentId === meta.documentId &&
              item.featureId === meta.featureId
            ),
        )
        .slice(0, 7),
    )
  }

  /** The pane registers how to read a STEP, IGES or STL file. Returns the unsubscribe function. */
  registerImport(provider: ImportProvider): () => void {
    this.importProvider = provider
    return () => {
      if (this.importProvider === provider) this.importProvider = undefined
    }
  }

  /** The pane registers how to measure the rebuilt solid. Returns the unsubscribe function. */
  registerQuery(provider: QueryProvider): () => void {
    this.queryProvider = provider
    return () => {
      if (this.queryProvider === provider) this.queryProvider = undefined
    }
  }

  /** The pane registers how to rebuild after an edit. Returns the unsubscribe function. */
  registerRebuild(provider: RebuildProvider): () => void {
    this.rebuildProvider = provider
    return () => {
      if (this.rebuildProvider === provider) this.rebuildProvider = undefined
    }
  }

  /** Sends a request to every app that can render; the first to answer wins. */
  private ask(
    build: (id: string) => ServerFrame,
    timeoutMs: number,
    what: string,
  ): Promise<Answer> {
    const able = [...this.clients.values()].filter((c) => c.canRender)
    if (!able.length) return Promise.resolve({ ok: false, error: NEEDS_CAD_PANE })
    const id = `c${this.nextCall++}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({
          ok: false,
          error: `The app did not ${what} within ${Math.round(timeoutMs / 1000)} s.`,
        })
      }, timeoutMs)
      this.pending.set(id, { clients: new Set(able.map((c) => c.id)), resolve, timer })
      const frame = build(id)
      for (const c of able) c.send(frame)
    })
  }

  private live(): boolean {
    return [...this.clients.values()].some((client) => client.canRender)
  }

  private within<T>(work: Promise<T>, timeoutMs: number, what: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`The app did not ${what} within ${Math.round(timeoutMs / 1000)} s.`))
      }, timeoutMs)
      work.then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (err: unknown) => {
          clearTimeout(timer)
          reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    })
  }

  /** Runs a pane handler. A throw and a rejection both become a failed tool result. */
  private callProvider<T>(run: () => T | Promise<T>, timeoutMs: number, what: string): Promise<T> {
    return this.within(Promise.resolve().then(run), timeoutMs, what)
  }

  /** Asks the connected apps for a picture of a model. A registered provider answers first. */
  render(request: ScreenshotRequest, timeoutMs = RENDER_TIMEOUT_MS): Promise<RenderResult> {
    const provider = this.screenshotProvider
    if (!provider) {
      return this.ask(
        (id) => ({ t: 'cad.render', id, ...request }),
        timeoutMs,
        'draw the CAD model',
      ) as Promise<RenderResult>
    }
    return this.callProvider(() => provider(request), timeoutMs, 'draw the CAD model').then(
      (source) => {
        const image = pngImage(source)
        if ('error' in image) return { ok: false as const, error: image.error }
        return { ok: true as const, image }
      },
      (err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  /** Asks the connected apps to measure a model. A registered provider answers first. */
  query(request: QueryRequest, timeoutMs = 15_000): Promise<QueryResult> {
    const provider = this.queryProvider
    if (!provider) {
      return this.ask(
        (id) => ({ t: 'cad.query', id, ...request }),
        timeoutMs,
        'measure the CAD model',
      ) as Promise<QueryResult>
    }
    return this.callProvider(() => provider(request), timeoutMs, 'measure the CAD model').then(
      (geometry) =>
        geometry === undefined || geometry === null
          ? { ok: false as const, error: 'The app returned no measurement.' }
          : { ok: true as const, geometry },
      (err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  /** Asks the connected apps to read a STEP, IGES or STL file into features. */
  importFile(request: ImportRequest, timeoutMs = RENDER_TIMEOUT_MS): Promise<ImportResult> {
    return this.ask(
      (id) => ({ t: 'cad.import', id, ...request }),
      timeoutMs,
      'import the CAD file',
    ) as Promise<ImportResult>
  }

  /**
   * Asks the pane to import a file and waits. An in-process handler answers first, otherwise the
   * connected CAD pane does.
   */
  requestImport(request: ImportRequest, timeoutMs = RENDER_TIMEOUT_MS): Promise<ImportResult> {
    const provider = this.importProvider
    if (provider) {
      return this.callProvider(() => provider(request), timeoutMs, 'import the CAD file').then(
        (result) => readImport(result),
        (err: unknown) => ({
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    if (!this.live()) return Promise.resolve({ ok: false, error: NEEDS_CAD_PANE })
    return this.importFile(request, timeoutMs)
  }

  /** Asks the connected apps to write a STEP or STL file. */
  exportFile(
    request: { documentId: string; document?: unknown; format: string; featureId?: string },
    timeoutMs = RENDER_TIMEOUT_MS,
  ): Promise<ExportResult> {
    return this.ask(
      (id) => ({ t: 'cad.export', id, ...request }),
      timeoutMs,
      'export the CAD model',
    ) as Promise<ExportResult>
  }

  /**
   * Asks the pane to export and waits. A handler answers while the pane is connected. Stored bytes
   * are used when it is not. Otherwise the caller is told the pane has to export.
   */
  requestExport(
    format: string,
    request: { documentId?: string; document?: unknown; featureId?: string } = {},
    timeoutMs = RENDER_TIMEOUT_MS,
  ): Promise<ExportResult> {
    const asked = format.trim().toLowerCase()
    const full: ExportRequest = {
      documentId: request.documentId ?? '',
      document: request.document,
      format: asked,
      featureId: request.featureId,
    }
    const provider = this.exportProvider
    if (provider) {
      return this.callProvider(() => provider(full), timeoutMs, 'export the CAD model').then(
        (payload) => normalizeExport(payload, asked),
        (err: unknown) => ({
          ok: false as const,
          error: err instanceof Error ? err.message : String(err),
        }),
      )
    }
    if (this.live()) return this.exportFile(full, timeoutMs)
    const stored = this.findStored(asked, request.documentId, request.featureId)
    if (stored) return Promise.resolve({ ok: true, file: stored })
    return Promise.resolve({ ok: false, error: NEEDS_CAD_PANE })
  }

  /** Asks the connected apps to rebuild a model after an edit. A registered provider answers first. */
  rebuild(request: RebuildRequest, timeoutMs = 15_000): Promise<RebuildResult> {
    const provider = this.rebuildProvider
    if (!provider) {
      return this.ask(
        (id) => ({ t: 'cad.rebuild', id, ...request }),
        timeoutMs,
        'rebuild the CAD model',
      ) as Promise<RebuildResult>
    }
    return this.callProvider(() => provider(request), timeoutMs, 'rebuild the CAD model').then(
      (result) => readRebuild(result),
      (err: unknown) => ({
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
  }

  private findStored(
    format: string,
    documentId?: string,
    featureId?: string,
  ): { data: string; mime: string; filename?: string } | undefined {
    const key = canonicalFormat(format)
    const found = this.storedExports.find((item) => {
      if (item.format !== key) return false
      if (documentId && item.documentId && item.documentId !== documentId) return false
      if (featureId) return item.featureId === featureId
      return !item.featureId
    })
    if (!found) return undefined
    return {
      data: found.data,
      mime: found.mime,
      ...(found.filename ? { filename: found.filename } : {}),
    }
  }
}

function canonicalFormat(format: string): string {
  const value = format.trim().toLowerCase()
  if (value === 'stp') return 'step'
  if (value === 'igs') return 'iges'
  return value
}

function mimeFor(format: string): string {
  switch (canonicalFormat(format)) {
    case 'stl':
      return 'model/stl'
    case 'step':
      return 'model/step'
    case 'iges':
      return 'model/iges'
    case 'json':
      return 'application/json'
    default:
      return 'application/octet-stream'
  }
}

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)
}

/** Turns provider output into the base64 PNG the screenshot tool returns. */
function pngImage(source: ScreenshotSource): { data: string; mime: string } | { error: string } {
  if (typeof source !== 'string') {
    if (!isPng(source)) return { error: 'Screenshot is not a PNG.' }
    return { data: Buffer.from(source).toString('base64'), mime: 'image/png' }
  }
  const trimmed = source.trim()
  const dataUrl = /^data:image\/png(?:;[^,]*)?;base64,([\sA-Za-z0-9+/=]+)$/i.exec(trimmed)
  if (dataUrl?.[1]) {
    const bytes = Buffer.from(dataUrl[1].replace(/\s/g, ''), 'base64')
    if (!isPng(bytes)) return { error: 'Screenshot is not a PNG.' }
    return { data: bytes.toString('base64'), mime: 'image/png' }
  }
  const compact = trimmed.replace(/\s/g, '')
  if (/^[A-Za-z0-9+/]+={0,2}$/.test(compact) && compact.length >= 12) {
    const bytes = Buffer.from(compact, 'base64')
    if (isPng(bytes)) return { data: bytes.toString('base64'), mime: 'image/png' }
  }
  return { error: 'Screenshot is not a PNG. Return PNG bytes or a data:image/png URL.' }
}

function fileData(source: Uint8Array | string): string | undefined {
  if (typeof source !== 'string') {
    if (source.byteLength === 0) return undefined
    return Buffer.from(source).toString('base64')
  }
  const trimmed = source.trim()
  if (!trimmed) return undefined
  const dataUrl = /^data:([^,]*),([\s\S]+)$/i.exec(trimmed)
  if (!dataUrl) return trimmed
  const meta = dataUrl[1] ?? ''
  const body = dataUrl[2] ?? ''
  if (/;base64/i.test(meta)) return body.replace(/\s/g, '') || undefined
  return Buffer.from(decodeURIComponent(body), 'utf8').toString('base64')
}

function normalizeExport(payload: ExportPayload, format: string): ExportResult {
  if (typeof payload === 'string' || payload instanceof Uint8Array) {
    const data = fileData(payload)
    if (!data) return { ok: false, error: 'The app returned an empty file.' }
    return { ok: true, file: { data, mime: mimeFor(format) } }
  }
  if (!payload || typeof payload !== 'object' || payload.data === undefined) {
    return { ok: false, error: 'The app returned no file.' }
  }
  const data = fileData(payload.data)
  if (!data) return { ok: false, error: 'The app returned an empty file.' }
  const filename = payload.filename?.trim().slice(0, 200)
  return {
    ok: true,
    file: {
      data,
      mime: payload.mime?.trim() || mimeFor(format),
      ...(filename ? { filename } : {}),
    },
  }
}

function readImport(
  result: { features?: unknown[]; sketches?: unknown[]; error?: string } | null | undefined,
): ImportResult {
  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'The app returned no features.' }
  }
  if (!result.features && !result.sketches) {
    return { ok: false, error: result.error || 'The app returned no features.' }
  }
  return { ok: true, features: result.features ?? [], sketches: result.sketches ?? [] }
}

function readRebuild(result: void | { ok?: boolean; error?: string }): RebuildResult {
  if (result && typeof result === 'object' && (result.ok === false || result.error)) {
    return { ok: false, error: result.error || 'The app could not rebuild the CAD model.' }
  }
  return { ok: true }
}
