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

const RENDER_TIMEOUT_MS = 20_000

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

/**
 * The connected apps that can draw CAD models for agents, what each has open in the CAD pane, and
 * the pictures and measurements asked of them. Like the design link: the agent's tool waits here.
 */
export class CadLink {
  private readonly clients = new Map<number, Client>()
  private readonly pending = new Map<string, Pending>()
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

  /** Asks the connected apps for a picture of a model. */
  render(
    request: { documentId: string; document?: unknown; featureId?: string; scale?: number },
    timeoutMs = RENDER_TIMEOUT_MS,
  ): Promise<RenderResult> {
    return this.ask(
      (id) => ({ t: 'cad.render', id, ...request }),
      timeoutMs,
      'draw the CAD model',
    ) as Promise<RenderResult>
  }

  /** Asks the connected apps to measure a model. */
  query(
    request: { documentId: string; document?: unknown; featureId?: string; what?: string },
    timeoutMs = 15_000,
  ): Promise<QueryResult> {
    return this.ask(
      (id) => ({ t: 'cad.query', id, ...request }),
      timeoutMs,
      'measure the CAD model',
    ) as Promise<QueryResult>
  }

  /** Asks the connected apps to read a STEP, IGES or STL file into features. */
  importFile(
    request: { format: string; data: string; filename?: string; documentId?: string },
    timeoutMs = RENDER_TIMEOUT_MS,
  ): Promise<ImportResult> {
    return this.ask(
      (id) => ({ t: 'cad.import', id, ...request }),
      timeoutMs,
      'import the CAD file',
    ) as Promise<ImportResult>
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

  /** Asks the connected apps to rebuild a model after an edit. */
  rebuild(
    request: { documentId: string; document?: unknown },
    timeoutMs = 15_000,
  ): Promise<RebuildResult> {
    return this.ask(
      (id) => ({ t: 'cad.rebuild', id, ...request }),
      timeoutMs,
      'rebuild the CAD model',
    ) as Promise<RebuildResult>
  }
}
