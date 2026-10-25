import { hostRequest } from '../../stores/host.ts'
import { normalizeServerElement } from './lib/server-project'
import { findElementInList } from './lib/element-utils'
import { renderElementToDataUrl } from './lib/export'
import type { DesignElement } from './store/editor-store'

export interface RenderRequest {
  designId: string
  pageId?: string
  elementId?: string
  scale?: number
}

const MAX_SIDE = 1600
const PAD = 24
const BACKGROUND = '#e8e8e8'

/** Where the elements start and how far they reach, children counted from their parents. */
function bounds(list: DesignElement[], dx = 0, dy = 0) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const el of list) {
    const x = el.x + dx
    const y = el.y + dy
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x + el.width)
    maxY = Math.max(maxY, y + el.height)
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Draws a design (or one element of it) the way the editor shows it, for an agent to look at. Works
 * from the host's copy, so it needs no canvas on screen.
 */
export async function renderForAgent(hostKey: string, req: RenderRequest) {
  const design = await hostRequest(hostKey, 'design.get', { id: req.designId })
  const project = design.project as { pages?: { id: string; elements?: unknown[] }[] }
  const pages = project.pages ?? []
  const page = pages.find((p) => p.id === req.pageId) ?? pages[0]
  const elements = (page?.elements ?? []).map(normalizeServerElement)

  let root: DesignElement
  if (req.elementId) {
    const found = findElementInList(elements, req.elementId)
    if (!found) throw new Error(`No element ${req.elementId} on that page`)
    root = found
  } else {
    if (elements.length === 0) throw new Error('That page is empty, so there is nothing to draw.')
    const b = bounds(elements)
    root = normalizeServerElement({
      id: 'agent-render-root',
      type: 'frame',
      name: 'Page',
      x: 0,
      y: 0,
      width: Math.ceil(b.maxX - b.minX) + PAD * 2,
      height: Math.ceil(b.maxY - b.minY) + PAD * 2,
      fill: 'transparent',
      clipContent: false,
      children: elements.map((e) => ({ ...e, x: e.x - b.minX + PAD, y: e.y - b.minY + PAD })),
    })
  }
  const longest = Math.max(root.width, root.height, 1)
  const scale = Math.min(req.scale ?? 1, MAX_SIDE / longest)
  const url = await renderElementToDataUrl(root, { scale, background: BACKGROUND })
  return { data: url.slice(url.indexOf(',') + 1), mime: 'image/png' }
}

/** SVG markup an agent wrote, as editable elements (one frame holding the shapes). */
export async function importSvgForAgent(svg: string, width?: number) {
  const { importSvgText } = await import('./lib/import/svg-import')
  const { generateId } = await import('./store/editor-store')
  let text = svg
  if (width && width > 0) {
    // A width on the root sets the scale; the height follows the viewBox.
    const doc = new DOMParser().parseFromString(svg, 'image/svg+xml')
    const root = doc.documentElement
    if (root.tagName.toLowerCase() === 'svg' && root.getAttribute('viewBox')) {
      root.setAttribute('width', String(width))
      root.removeAttribute('height')
      text = new XMLSerializer().serializeToString(root)
    }
  }
  const result = importSvgText(text, (prefix) => generateId(prefix), true)
  if (result.elements.length === 0) throw new Error('The SVG had no shapes the editor could draw')
  return result.elements
}
