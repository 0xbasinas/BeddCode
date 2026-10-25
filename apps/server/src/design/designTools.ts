import { randomBytes } from 'node:crypto'
import type { DesignProject } from '@beddcode/contracts'
import type { DesignStore } from './designStore.ts'

export const DESIGN_TOOL_NAMES = [
  'design_list',
  'design_create',
  'design_read',
  'design_add',
  'design_update',
  'design_remove',
  'design_add_page',
] as const
export type DesignToolName = (typeof DESIGN_TOOL_NAMES)[number]
export const isDesignToolName = (name: string): name is DesignToolName =>
  (DESIGN_TOOL_NAMES as readonly string[]).includes(name)

/** The element fields an agent may set (the editor's own whitelist; anything else is dropped). */
const FIELDS: ReadonlySet<string> = new Set([
  'name', 'type', 'x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'locked',
  'flipH', 'flipV', 'blendMode', 'fill', 'stroke', 'strokeWidth', 'strokeStyle', 'strokeAlign',
  'cornerRadius', 'cornerRadiusTL', 'cornerRadiusTR', 'cornerRadiusBL', 'cornerRadiusBR',
  'fills', 'strokes', 'shadows', 'blurs', 'textContent', 'fontFamily', 'fontSize', 'fontWeight',
  'fontStyle', 'textDecoration', 'textAlign', 'lineHeight', 'letterSpacing', 'textColor',
  'textAutoResize', 'textAlignVertical', 'pathPoints', 'pathClosed', 'sides', 'innerRadius',
  'autoLayout', 'clipContent', 'constraints', 'layoutSizingH', 'layoutSizingV',
  'layoutPositioning', 'minWidth', 'maxWidth', 'minHeight', 'maxHeight', 'arrowHeadStyle',
])

const ADD_TYPES = [
  'frame', 'rectangle', 'ellipse', 'text', 'line', 'arrow', 'polygon', 'star', 'group',
] as const
const CONTAINERS = new Set<string>(['frame', 'group'])
const MAX_ELEMENTS = 300
const MAX_DEPTH = 8

const design = {
  type: 'string',
  description: 'Design id from design_list. Omit to use the most recently changed design.',
}
const page = { type: 'string', description: 'Page id from design_read; the active page if omitted.' }

const elementProps = {
  type: { type: 'string', enum: ADD_TYPES },
  name: { type: 'string' },
  x: { type: 'number', description: 'Position; for a child, relative to its parent’s top-left.' },
  y: { type: 'number' },
  width: { type: 'number' },
  height: { type: 'number' },
  fill: { type: 'string', description: 'Fill colour, e.g. "#0D99FF" or "transparent".' },
  stroke: { type: 'string' },
  strokeWidth: { type: 'number' },
  cornerRadius: { type: 'number' },
  opacity: { type: 'number', description: '0 to 100.' },
  rotation: { type: 'number', description: 'Degrees.' },
  textContent: { type: 'string', description: 'For text.' },
  fontSize: { type: 'number' },
  fontWeight: { type: 'number' },
  fontFamily: { type: 'string' },
  textColor: { type: 'string', description: 'Text colour (text uses this, not fill).' },
  textAlign: { type: 'string', enum: ['left', 'center', 'right', 'justified'] },
  sides: { type: 'number', description: 'For polygon and star.' },
  autoLayout: {
    type: 'object',
    description:
      'On a frame: lays its children out in a row or column. Fields: direction ("horizontal" | "vertical"), gap, paddingTop/Right/Bottom/Left, alignItems, justifyContent.',
  },
  clipContent: { type: 'boolean', description: 'On a frame: hide what sticks out.' },
}

/** The tools, as MCP lists them. */
export const DESIGN_TOOL_DEFINITIONS = [
  {
    name: 'design_list',
    description: 'Lists the design canvases on this host, most recently changed first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'design_create',
    description: 'Creates a new, empty design canvas (one blank page) and returns its id.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
  {
    name: 'design_read',
    description:
      'Reads a design: its pages and the elements of one page as a tree with id, type, name, x, y, width, height and the main style fields. Read before changing something you did not draw, and after drawing to check the result.',
    inputSchema: {
      type: 'object',
      properties: {
        design,
        page,
        max_depth: { type: 'number', description: 'How many levels of children to include (default 4).' },
      },
    },
  },
  {
    name: 'design_add',
    description:
      'Adds elements to a page, or inside a frame or group (parent). Each element needs a type; give x, y, width, height and style fields as needed. A frame or group may carry "children" (same shape, positions relative to it). Returns the new ids. The user sees them appear in the Design screen at once.',
    inputSchema: {
      type: 'object',
      properties: {
        design,
        page,
        parent: { type: 'string', description: 'Id of a frame or group to add into; the page itself if omitted.' },
        elements: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              ...elementProps,
              children: { type: 'array', items: { type: 'object' } },
            },
            required: ['type'],
          },
        },
      },
      required: ['elements'],
    },
  },
  {
    name: 'design_update',
    description:
      'Changes elements: each update has the element id and the fields to set (x, y, width, height, fill, textContent, …). Fields you leave out stay as they are.',
    inputSchema: {
      type: 'object',
      properties: {
        design,
        updates: {
          type: 'array',
          items: {
            type: 'object',
            properties: { id: { type: 'string' }, ...elementProps },
            required: ['id'],
          },
        },
      },
      required: ['updates'],
    },
  },
  {
    name: 'design_remove',
    description: 'Deletes elements (and what is inside them) by id.',
    inputSchema: {
      type: 'object',
      properties: { design, ids: { type: 'array', items: { type: 'string' } } },
      required: ['ids'],
    },
  },
  {
    name: 'design_add_page',
    description: 'Adds an empty page to a design and returns its id.',
    inputSchema: { type: 'object', properties: { design, name: { type: 'string' } } },
  },
] as const

export const DESIGN_INSTRUCTIONS = `BeddCode design canvas. You can draw on the design canvases kept on this host; the user has the same canvas open in the Design screen and sees your changes as you make them.
- design_read first when working on an existing design. Coordinates are in pixels, origin top-left; a child's x and y are relative to its frame or group.
- Build in a few design_add calls rather than many: a frame per screen or card, with its children inside it. Give frames a fill and a size before filling them.
- Text uses textContent, fontSize and textColor (not fill). Colours are CSS strings.
- Use design_read afterwards to check positions and sizes; nothing is rendered for you, so keep your own sums right.`

type Args = Record<string, unknown>
type El = Record<string, unknown> & { id: string; type: string; children?: El[] }
interface Page {
  id: string
  name: string
  elements: El[]
}
export interface DesignMcpResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

const ok = (value: unknown): DesignMcpResult => ({
  content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})
const fail = (text: string): DesignMcpResult => ({ content: [{ type: 'text', text }], isError: true })

const newId = (type: string) => `${type}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`

function pick(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [k, v] of Object.entries(raw)) {
    if (!FIELDS.has(k) || v === undefined) continue
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    out[k] = v
  }
  return out
}

function pagesOf(project: DesignProject): Page[] {
  if (!Array.isArray(project.pages) || project.pages.length === 0)
    project.pages = [{ id: 'page-1', name: 'Page 1', elements: [] }]
  return project.pages as Page[]
}

function pageOf(project: DesignProject, id?: string): Page {
  const pages = pagesOf(project)
  const found = pages.find((p) => p.id === (id ?? project.activePageId))
  if (!found && id) throw new Error(`No page ${id}. Pages: ${pages.map((p) => p.id).join(', ')}`)
  return found ?? pages[0]!
}

function find(list: El[], id: string): { el: El; siblings: El[] } | undefined {
  for (const el of list) {
    if (el.id === id) return { el, siblings: list }
    if (el.children) {
      const hit = find(el.children, id)
      if (hit) return hit
    }
  }
  return undefined
}

function build(raw: unknown, depth: number, budget: { left: number }): El {
  if (budget.left-- <= 0) throw new Error(`At most ${MAX_ELEMENTS} elements per call`)
  if (depth > MAX_DEPTH) throw new Error(`Elements nest at most ${MAX_DEPTH} levels deep`)
  const src = (raw ?? {}) as Args
  const type = String(src.type ?? '')
  if (!(ADD_TYPES as readonly string[]).includes(type))
    throw new Error(`Unknown element type "${type}". Use one of: ${ADD_TYPES.join(', ')}`)
  const props = pick(src)
  const isText = type === 'text'
  const el: El = {
    strokeStyle: 'solid',
    strokeAlign: 'center',
    opacity: 100,
    rotation: 0,
    visible: true,
    locked: false,
    x: 0,
    y: 0,
    width: isText ? 200 : 100,
    height: isText ? Math.round((Number(props.fontSize) || 18) * 1.4) : 100,
    fill: type === 'frame' ? '#FFFFFF' : isText || type === 'group' ? 'transparent' : '#D9D9D9',
    stroke: 'transparent',
    strokeWidth: 0,
    cornerRadius: 0,
    ...(type === 'frame' ? { clipContent: true } : {}),
    ...props,
    id: newId(type),
    type,
    name:
      typeof props.name === 'string' && props.name
        ? props.name
        : type[0]!.toUpperCase() + type.slice(1),
  }
  if (Array.isArray(src.children) && src.children.length) {
    if (!CONTAINERS.has(type)) throw new Error(`A ${type} cannot have children; use a frame or group`)
    el.children = src.children.map((c) => build(c, depth + 1, budget))
  } else if (CONTAINERS.has(type)) el.children = []
  return el
}

function summarize(el: El, depth: number): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: el.id,
    type: el.type,
    name: el.name,
    x: el.x,
    y: el.y,
    width: el.width,
    height: el.height,
  }
  if (el.type === 'text') {
    out.text = el.textContent
    out.fontSize = el.fontSize
    out.textColor = el.textColor
  } else if (typeof el.fill === 'string' && el.fill !== 'transparent') out.fill = el.fill
  if (typeof el.stroke === 'string' && el.stroke !== 'transparent') out.stroke = el.stroke
  if (el.cornerRadius) out.cornerRadius = el.cornerRadius
  if (el.visible === false) out.hidden = true
  if (el.autoLayout) out.autoLayout = el.autoLayout
  if (el.children?.length) {
    if (depth > 0) out.children = el.children.map((c) => summarize(c, depth - 1))
    else out.children = `${el.children.length} more (raise max_depth)`
  }
  return out
}

/** The design tools: they work on the host's designs directly, so no editor has to be open. */
export class DesignTools {
  constructor(private readonly designs: DesignStore) {}

  private resolve(args: Args): string {
    const given = typeof args.design === 'string' ? args.design : undefined
    if (given) {
      if (!this.designs.get(given)) throw new Error(`No design ${given}. See design_list.`)
      return given
    }
    return this.designs.list()[0]?.id ?? this.designs.create('Untitled', 'agent').id
  }

  call(tool: DesignToolName, args: Args): DesignMcpResult {
    try {
      return ok(this.run(tool, args))
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }

  private run(tool: DesignToolName, args: Args): unknown {
    switch (tool) {
      case 'design_list':
        return { designs: this.designs.list() }
      case 'design_create': {
        const d = this.designs.create(typeof args.name === 'string' ? args.name : undefined, 'agent')
        return { id: d.id, name: d.name, page: 'page-1' }
      }
      case 'design_read': {
        const id = this.resolve(args)
        const d = this.designs.get(id)!
        const pg = pageOf(d.project, typeof args.page === 'string' ? args.page : undefined)
        const depth = Math.min(Math.max(Number(args.max_depth) || 4, 0), MAX_DEPTH)
        return {
          design: id,
          name: d.name,
          rev: d.rev,
          pages: pagesOf(d.project).map((p) => ({ id: p.id, name: p.name, elements: p.elements.length })),
          page: pg.id,
          elements: pg.elements.map((e) => summarize(e, depth)),
        }
      }
      case 'design_add': {
        const id = this.resolve(args)
        if (!Array.isArray(args.elements) || !args.elements.length)
          throw new Error('elements must be a non-empty array')
        const budget = { left: MAX_ELEMENTS }
        const made = args.elements.map((e) => build(e, 0, budget))
        const parent = typeof args.parent === 'string' ? args.parent : undefined
        this.designs.mutate(
          id,
          (project) => {
            const pg = pageOf(project, typeof args.page === 'string' ? args.page : undefined)
            if (parent) {
              const hit = find(pg.elements, parent)
              if (!hit) throw new Error(`No element ${parent} on page ${pg.id}`)
              if (!CONTAINERS.has(hit.el.type))
                throw new Error(`${parent} is a ${hit.el.type}, not a frame or group`)
              hit.el.children = [...(hit.el.children ?? []), ...made]
            } else pg.elements.push(...made)
          },
          'agent',
        )
        const ids = (els: El[]): unknown[] =>
          els.map((e) => (e.children?.length ? { id: e.id, children: ids(e.children) } : e.id))
        return { design: id, added: ids(made) }
      }
      case 'design_update': {
        const id = this.resolve(args)
        if (!Array.isArray(args.updates) || !args.updates.length)
          throw new Error('updates must be a non-empty array')
        const missing: string[] = []
        this.designs.mutate(
          id,
          (project) => {
            for (const raw of args.updates as Args[]) {
              const elId = String(raw.id ?? '')
              let hit: ReturnType<typeof find>
              for (const pg of pagesOf(project)) {
                hit = find(pg.elements, elId)
                if (hit) break
              }
              if (!hit) {
                missing.push(elId)
                continue
              }
              const props = pick(raw)
              delete props.type
              Object.assign(hit.el, props)
            }
          },
          'agent',
        )
        if (missing.length)
          throw new Error(`No element with id ${missing.join(', ')} (the others were updated)`)
        return { design: id, updated: (args.updates as Args[]).length }
      }
      case 'design_remove': {
        const id = this.resolve(args)
        if (!Array.isArray(args.ids) || !args.ids.length)
          throw new Error('ids must be a non-empty array')
        let removed = 0
        this.designs.mutate(
          id,
          (project) => {
            for (const elId of args.ids as unknown[]) {
              for (const pg of pagesOf(project)) {
                const hit = find(pg.elements, String(elId))
                if (!hit) continue
                hit.siblings.splice(hit.siblings.indexOf(hit.el), 1)
                removed++
                break
              }
            }
          },
          'agent',
        )
        return { design: id, removed }
      }
      case 'design_add_page': {
        const id = this.resolve(args)
        const pageId = `page-${randomBytes(3).toString('hex')}`
        this.designs.mutate(
          id,
          (project) => {
            const pages = pagesOf(project)
            pages.push({
              id: pageId,
              name:
                typeof args.name === 'string' && args.name ? args.name : `Page ${pages.length + 1}`,
              elements: [],
            })
          },
          'agent',
        )
        return { design: id, page: pageId }
      }
    }
  }
}
