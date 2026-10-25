import type { ClientFrame, ServerFrame } from '@beddcode/contracts'

type ViewFrame = Extract<ClientFrame, { t: 'design.view' }>
type RenderedFrame = Extract<ClientFrame, { t: 'design.rendered' }>
type ImportedFrame = Extract<ClientFrame, { t: 'design.imported' }>

export interface DesignView {
  designId?: string
  pageId?: string
  selection: string[]
}

export interface RenderRequest {
  designId: string
  pageId?: string
  elementId?: string
  scale?: number
}

export type RenderResult = { ok: true; image: { data: string; mime: string } } | { ok: false; error: string }
export type ImportResult = { ok: true; elements: unknown[] } | { ok: false; error: string }
type Answer = RenderResult | ImportResult

const RENDER_TIMEOUT_MS = 20_000

interface Client {
  id: number
  send(frame: ServerFrame): void
  canRender: boolean
  view: DesignView
  /** When the view last changed, epoch ms. */
  at: number
}

interface Pending {
  clients: Set<number>
  resolve(result: Answer): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * The connected apps that can draw designs for agents, what each has open in the Design screen, and
 * the pictures asked of them. Like the browser broker: the agent's tool waits here for a client.
 */
export class DesignLink {
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
      frame: (frame: ViewFrame | RenderedFrame | ImportedFrame) => {
        if (frame.t === 'design.view') {
          client.canRender = frame.canRender
          client.view = {
            designId: frame.designId,
            pageId: frame.pageId,
            selection: frame.selection ?? [],
          }
          client.at = Date.now()
          this.clients.set(client.id, client)
          return
        }
        const p = this.pending.get(frame.id)
        if (!p || !p.clients.has(client.id)) return
        // A client that could not draw it does not end the wait while another may still answer.
        const answered = frame.t === 'design.rendered' ? frame.image : frame.elements
        if (!answered) {
          p.clients.delete(client.id)
          if (p.clients.size > 0) return
        }
        this.pending.delete(frame.id)
        clearTimeout(p.timer)
        p.resolve(
          frame.t === 'design.rendered' && frame.image
            ? { ok: true, image: frame.image }
            : frame.t === 'design.imported' && frame.elements
              ? { ok: true, elements: frame.elements }
              : { ok: false, error: frame.error ?? 'The app could not do this.' },
        )
      },
      close: () => {
        this.clients.delete(client.id)
        for (const [id, p] of this.pending) {
          if (!p.clients.delete(client.id) || p.clients.size > 0) continue
          this.pending.delete(id)
          clearTimeout(p.timer)
          p.resolve({ ok: false, error: 'The app that was drawing the design disconnected.' })
        }
      },
    }
  }

  /** What the user looked at last in a Design screen, if one is open. */
  current(): DesignView | undefined {
    const open = [...this.clients.values()]
      .filter((c) => c.view.designId)
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
    if (!able.length)
      return Promise.resolve({
        ok: false,
        error:
          'No BeddCode app that can draw designs is connected to this host. Ask the user to open the BeddCode desktop or web app and try again.',
      })
    const id = `r${this.nextCall++}`
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: `The app did not ${what} within ${Math.round(timeoutMs / 1000)} s.` })
      }, timeoutMs)
      this.pending.set(id, { clients: new Set(able.map((c) => c.id)), resolve, timer })
      const frame = build(id)
      for (const c of able) c.send(frame)
    })
  }

  /** Asks the connected apps for a picture. */
  render(request: RenderRequest, timeoutMs = RENDER_TIMEOUT_MS): Promise<RenderResult> {
    return this.ask((id) => ({ t: 'design.render', id, ...request }), timeoutMs, 'draw the design') as Promise<RenderResult>
  }

  /** Asks the connected apps to turn SVG markup into design elements. */
  importSvg(svg: string, width?: number, timeoutMs = RENDER_TIMEOUT_MS): Promise<ImportResult> {
    return this.ask((id) => ({ t: 'design.import', id, svg, width }), timeoutMs, 'read the SVG') as Promise<ImportResult>
  }
}
