import { randomBytes } from 'node:crypto'
import type { DesignProject } from '@beddcode/contracts'
import type { DesignStore } from './designStore.ts'
import type { DesignLink } from './designLink.ts'
import { DESIGN_SKILL_NAMES, designSkill, searchDesignKnowledge } from './designSkills.ts'

export const DESIGN_TOOL_NAMES = [
  'design_list',
  'design_create',
  'design_read',
  'design_add',
  'design_update',
  'design_remove',
  'design_add_page',
  'design_screenshot',
  'design_get_selection',
  'design_add_svg',
  'design_duplicate',
  'design_move',
  'design_arrange',
  'design_check_layout',
  'design_skill',
  'design_search_knowledge',
] as const
export type DesignToolName = (typeof DESIGN_TOOL_NAMES)[number]
export const isDesignToolName = (name: string): name is DesignToolName =>
  (DESIGN_TOOL_NAMES as readonly string[]).includes(name)

/** The element fields an agent may set (the editor's own whitelist; anything else is dropped). */
const FIELDS: ReadonlySet<string> = new Set([
  'name',
  'type',
  'x',
  'y',
  'width',
  'height',
  'rotation',
  'opacity',
  'visible',
  'locked',
  'flipH',
  'flipV',
  'blendMode',
  'fill',
  'stroke',
  'strokeWidth',
  'strokeStyle',
  'strokeAlign',
  'cornerRadius',
  'cornerRadiusTL',
  'cornerRadiusTR',
  'cornerRadiusBL',
  'cornerRadiusBR',
  'fills',
  'strokes',
  'shadows',
  'blurs',
  'textContent',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'textDecoration',
  'textAlign',
  'lineHeight',
  'letterSpacing',
  'textColor',
  'textAutoResize',
  'textAlignVertical',
  'pathPoints',
  'pathClosed',
  'sides',
  'innerRadius',
  'autoLayout',
  'clipContent',
  'constraints',
  'layoutSizingH',
  'layoutSizingV',
  'layoutPositioning',
  'minWidth',
  'maxWidth',
  'minHeight',
  'maxHeight',
  'arrowHeadStyle',
])

const MUTATING: ReadonlySet<string> = new Set([
  'design_add',
  'design_update',
  'design_remove',
  'design_add_page',
  'design_add_svg',
  'design_duplicate',
  'design_move',
  'design_arrange',
])

const ADD_TYPES = [
  'frame',
  'rectangle',
  'ellipse',
  'text',
  'line',
  'arrow',
  'polygon',
  'star',
  'group',
] as const
const CONTAINERS = new Set<string>(['frame', 'group'])
const MAX_ELEMENTS = 800
const MAX_DEPTH = 8

const design = {
  type: 'string',
  description: 'Design id from design_list. Omit to use the most recently changed design.',
}
const page = {
  type: 'string',
  description: 'Page id from design_read; the active page if omitted.',
}

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
  textAlignVertical: { type: 'string', enum: ['top', 'center', 'bottom'] },
  lineHeight: { type: 'number', description: 'Multiple of the font size, e.g. 1.4 (default).' },
  letterSpacing: { type: 'number', description: 'Pixels.' },
  textAutoResize: {
    type: 'string',
    enum: ['fixed', 'hug', 'grow'],
    description:
      'fixed: the box you set. hug: one line, the box sizes to its text (the default when you give no width). grow: wraps at your width, the height follows the text (the default when you give a width).',
  },
  fills: {
    type: 'array',
    description:
      'Several or non-solid paints, replacing fill. Each: {type:"solid"|"linear-gradient"|"radial-gradient", color, opacity (0-1), gradientStops:[{offset 0-1, color, opacity}], gradientAngle}.',
    items: { type: 'object' },
  },
  shadows: {
    type: 'array',
    description:
      'Drop or inner shadows. Each: {type:"drop-shadow"|"inner-shadow", x, y, blur, spread, color, opacity (0-1), visible:true}.',
    items: { type: 'object' },
  },
  blurs: {
    type: 'array',
    description: 'Each: {type:"blur"|"background-blur", radius, visible:true}.',
    items: { type: 'object' },
  },
  strokes: {
    type: 'array',
    description: 'Several strokes, replacing stroke. Each like a fill, plus width.',
    items: { type: 'object' },
  },
  cornerRadiusTL: {
    type: 'number',
    description: 'Per-corner radius (also cornerRadiusTR, BL, BR).',
  },
  layoutSizingH: {
    type: 'string',
    enum: ['fixed', 'hug', 'fill'],
    description: 'Inside an auto-layout frame.',
  },
  layoutSizingV: { type: 'string', enum: ['fixed', 'hug', 'fill'] },
  layoutPositioning: {
    type: 'string',
    enum: ['auto', 'absolute'],
    description: 'Use absolute for intentional overlays inside auto-layout frames.',
  },
  sides: { type: 'number', description: 'For polygon and star.' },
  autoLayout: {
    type: 'object',
    description:
      'On a frame: lays its children out in a row or column, so rows and lists line up by themselves (their x and y are worked out; do not set them). Everything not given is 0 or "start". Fields: direction ("horizontal" | "vertical"), gap, padding (all four sides) or paddingTop/Right/Bottom/Left, alignItems ("start"|"center"|"end"|"stretch"), justifyContent ("start"|"center"|"end"|"space-between"), primaryAxisSizing / counterAxisSizing ("fixed"|"hug"|"fill").',
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
        max_depth: {
          type: 'number',
          description: 'How many levels of children to include (default 4).',
        },
      },
    },
  },
  {
    name: 'design_add',
    description:
      'Adds elements to a page, or inside a frame or group (parent). For icons, logos and glyphs do NOT approximate them with rectangles, ellipses or characters: draw them with design_add_svg. For rows or items that repeat, add one and use design_duplicate. Each element needs a type; give x, y, width, height and style fields as needed. A frame or group may carry "children" (same shape, positions relative to it). Returns the new ids. The user sees them appear in the Design screen at once.',
    inputSchema: {
      type: 'object',
      properties: {
        design,
        page,
        parent: {
          type: 'string',
          description: 'Id of a frame or group to add into; the page itself if omitted.',
        },
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
  {
    name: 'design_screenshot',
    description:
      'Draws a design (a page, or one element and what is inside it) to a picture and returns it, so you can see what you made: layout, overlaps, clipped text, colours. Needs the BeddCode desktop or web app open on this host. Look at it after drawing, compare it with what you were asked for (or with the reference image), write down every difference, fix them, and take it again: two rounds at least before you report you are done. If you did not, say so plainly. Images have a maximum side of 1600 pixels, so large pages may be downscaled even at scale 2. Use element to inspect a representative panel or row at scale 2, and design_read to verify its actual dimensions and text sizes.',
    inputSchema: {
      type: 'object',
      properties: {
        design,
        page,
        element: {
          type: 'string',
          description: 'Id of one element to draw by itself; the whole page if omitted.',
        },
        scale: { type: 'number', description: 'Pixel scale, 0.25 to 2 (default 1).' },
      },
    },
  },
  {
    name: 'design_skill',
    description: `Loads a how-to guide for drawing well: ${DESIGN_SKILL_NAMES.join(', ')}. Call it with no name to list them, or with a name to read one (ready-made auto layout rows, an icon library as SVG, UI patterns, the reference-matching loop). Load 'workflow' before your first design, and 'icons' and 'auto-layout' before using them.`,
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The skill to read; omit to list them.' },
      },
    },
  },
  {
    name: 'design_get_selection',
    description:
      'What the user has selected in the Design screen right now (id, type, name, position, size and style of each element). When the user says "this", "these" or "the selected card", read this first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'design_add_svg',
    description:
      'Draws SVG markup as editable shapes (icons, logos, small illustrations): paths, circles, rects, lines, text. Write the SVG yourself, e.g. a 24x24 icon with stroke="currentColor"; currentColor becomes the "color" you give. Returns the id of the frame holding the shapes. Use this for EVERY icon instead of text glyphs. Needs the BeddCode desktop or web app open.',
    inputSchema: {
      type: 'object',
      properties: {
        design,
        page,
        parent: {
          type: 'string',
          description: 'Id of a frame or group to put it in; the page if omitted.',
        },
        svg: { type: 'string', description: 'A complete <svg> element with a viewBox.' },
        x: { type: 'number', description: 'Position (relative to parent).' },
        y: { type: 'number' },
        width: {
          type: 'number',
          description: 'Drawn width in pixels; the height follows the viewBox.',
        },
        color: {
          type: 'string',
          description: 'Replaces currentColor, e.g. "#9CA3AF". Default black.',
        },
        name: { type: 'string' },
      },
      required: ['svg'],
    },
  },
  {
    name: 'design_duplicate',
    description:
      'Copies an element (with everything inside it) count times, each copy offset by dx, dy from the previous one; for list rows, tabs, repeated cards. Returns the new ids; then change their text with design_update.',
    inputSchema: {
      type: 'object',
      properties: {
        design,
        id: { type: 'string' },
        count: { type: 'number', description: '1 to 20 (default 1).' },
        dx: { type: 'number' },
        dy: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'design_move',
    description:
      'Moves an element into another frame or group (or back to the page), and/or changes its stacking position, without redrawing it. Optional x and y set its new position inside the new parent.',
    inputSchema: {
      type: 'object',
      properties: {
        design,
        id: { type: 'string' },
        parent: {
          type: 'string',
          description:
            'Id of the frame or group to move into, or "page" for the page itself. Unchanged if omitted.',
        },
        index: {
          type: 'number',
          description: 'Position among its siblings, 0 = bottom of the stack; last if omitted.',
        },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['id'],
    },
  },
  {
    name: 'design_arrange',
    description:
      'Align, distribute, or snap free-positioned sibling elements. Auto-layout children must be adjusted through their parent instead.',
    inputSchema: {
      type: 'object',
      properties: {
        design,
        page,
        ids: { type: 'array', items: { type: 'string' } },
        operation: {
          type: 'string',
          enum: [
            'left',
            'center-x',
            'right',
            'top',
            'center-y',
            'bottom',
            'distribute-x',
            'distribute-y',
            'snap',
          ],
        },
        grid: { type: 'number', description: 'Grid spacing for snap, default 8 pixels.' },
      },
      required: ['ids', 'operation'],
    },
  },
  {
    name: 'design_check_layout',
    description:
      'Check a page for possible overflow, overlapping siblings and small alignment or spacing inconsistencies. Review warnings: overlays can be intentional. Geometry reflects the last editor layout pass.',
    inputSchema: { type: 'object', properties: { design, page } },
  },

  {
    name: 'design_search_knowledge',
    description:
      'Search bundled UI UX Pro Max design references for product, visual style, palettes, typography, UX or app interface patterns. Apply useful results to editable canvas designs.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'Product type and visual keywords, e.g. cybersecurity learning dashboard dark.',
        },
        domain: {
          type: 'string',
          enum: ['all', 'product', 'style', 'color', 'typography', 'ux', 'interface'],
        },
        limit: { type: 'number', description: 'Maximum results, 1 to 10 (default 5).' },
      },
      required: ['query'],
    },
  },
] as const

export const DESIGN_INSTRUCTIONS = `BeddCode design canvas. The user is asking you to create or edit an editable design on the open BeddCode canvas. Use the BeddCode design tools for the requested design, not HTML files or code, unless the user explicitly asks for code. If the design tools are unavailable, explain that; do not substitute a file. You can draw on the design canvases kept on this host; the user has the same canvas open in the Design screen and sees your changes as you make them.

Essential layout guidance (loaded automatically): Build rows, cards, navigation and lists as nested auto-layout frames. Use consistent padding and gaps, fixed widths for aligned table columns, and fill for flexible content. Give wrapping text a width and enough height; use hug for content-sized containers. Use absolute positioning only for deliberate overlays. Never assume a fixed frame has enough room: check the laid-out boxes and rendered screenshot, including right and bottom edges, truncated text, spacing, and clipping. Match density to the brief: do not default a spacious dashboard to tiny developer-tool rows. Give repeated rows a shared height, icon container, text column and padding; vertically align icons with the title/description group. Check a whole-frame screenshot for composition and a panel screenshot for readable text and icon detail, since large screenshots can be downscaled. Correct problems, then inspect again. If layout or screenshot is unavailable, say so rather than claiming verification.

For new UI designs, load design_skill('design-quality') and use design_search_knowledge with the product and style keywords before drawing. Load 'layout-review', 'typography-review' or 'color-and-surfaces' when the brief or visual review needs that detail. Use the guidance as inspiration and follow the user's brief.

Skills: call design_skill (no name) to list how-to guides, and load 'workflow' before your first design. 'auto-layout', 'icons', 'reference-matching' and 'ui-patterns' hold ready-made structures and an SVG icon library; read them instead of improvising.

Basics
- design_read first when working on an existing design. Coordinates are in pixels, origin top-left; a child's x and y are relative to its frame or group.
- Build in a few design_add calls: a frame per screen or card with its children inside. Give frames a fill and a size before filling them.
- Text uses textContent, fontSize, fontWeight, textColor, lineHeight, letterSpacing and textAlign (not fill). Use an available UI font suited to the brief and a monospace family where useful for code or paths. Colours are CSS strings.
- Use auto layout for every row, list, toolbar, card body and button: set autoLayout on the frame ({direction, gap, padding, alignItems, justifyContent}) and do not give its children x or y; they are placed for you. Children: layoutSizingH/V "fill" stretches along the frame, "hug" fits the content; a frame with primaryAxisSizing/counterAxisSizing "hug" grows to its children. Text without a width hugs its content. Example row: {type:"frame", name:"Row", width:260, height:32, fill:"transparent", autoLayout:{direction:"horizontal", gap:8, paddingLeft:12, paddingRight:12, alignItems:"center"}, children:[icon frame, {type:"text", textContent:"limits.ts", layoutSizingH:"fill"}, {type:"text", textContent:"+3 −1"}]}. Stack rows in a vertical auto layout frame. Positions you give are only for the top-level frames and for children you want absolutely placed (layoutPositioning:"absolute").
- Use design_arrange for free-positioned siblings and design_check_layout before finishing. Review and fix unintended warnings, preserving intentional overlays.
- After each edit the app works out auto layout and text sizes, so design_read and design_screenshot show the real result. Use design_duplicate for repeated rows.
- Icons, logos and glyphs: always design_add_svg with real vector shapes. Never use letters or unicode symbols as icons.

Matching a reference image
1. Study it before drawing: list its regions (header, rows, footer…), their pixel sizes and the type scale. Make the outer frame the same size and aspect ratio as the reference.
2. Take colours from the reference (backgrounds, borders, muted text, accents) and reuse the same few values everywhere. Dark UIs usually have 3 to 4 surface greys and 2 to 3 text greys; get the contrast right.
3. Match spacing: the same padding, gap and row height each time. Rounded corners and 1px borders matter; add them.
4. Name layers meaningfully (Header, Row, Button).
5. Verify: design_screenshot (scale 2 for detail), compare it with the reference, and list every difference (size, spacing, colour, weight, missing icon, alignment). Fix them with design_update and screenshot again. Do at least two passes before you say you are done.
- When the user says "this" or "the selected", call design_get_selection.`

type Args = Record<string, unknown>
type El = Record<string, unknown> & { id: string; type: string; children?: El[] }
interface Page {
  id: string
  name: string
  elements: El[]
}
export interface DesignMcpResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

const ok = (value: unknown): DesignMcpResult => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
})
const fail = (text: string): DesignMcpResult => ({
  content: [{ type: 'text', text }],
  isError: true,
})

const newId = (type: string) =>
  `${type}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`

const AXIS_SIZING = new Set(['fixed', 'hug', 'fill'])

/** An auto layout with every field set, so unspecified values are 0 and "start", not the editor's 10px. */
function normAutoLayout(raw: unknown, base?: unknown): Record<string, unknown> {
  const r = {
    ...(typeof base === 'object' && base !== null ? base : {}),
    ...(typeof raw === 'object' && raw !== null ? raw : {}),
  } as Record<string, unknown>
  const given = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const n = (v: unknown, d: number) =>
    v !== undefined && v !== null && Number.isFinite(Number(v)) ? Number(v) : d
  const pad = (side: string) => (given.padding !== undefined ? n(given.padding, 0) : n(r[side], 0))
  const sizing = (v: unknown) => (typeof v === 'string' && AXIS_SIZING.has(v) ? v : 'fixed')
  return {
    direction: r.direction === 'horizontal' ? 'horizontal' : 'vertical',
    gap: n(r.gap, 0),
    paddingTop: pad('paddingTop'),
    paddingRight: pad('paddingRight'),
    paddingBottom: pad('paddingBottom'),
    paddingLeft: pad('paddingLeft'),
    alignItems: typeof r.alignItems === 'string' ? r.alignItems : 'start',
    justifyContent: typeof r.justifyContent === 'string' ? r.justifyContent : 'start',
    primaryAxisSizing: sizing(r.primaryAxisSizing),
    counterAxisSizing: sizing(r.counterAxisSizing),
    ...(r.wrap === true ? { wrap: true, counterAxisGap: n(r.counterAxisGap, 0) } : {}),
  }
}

function pick(raw: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (typeof raw !== 'object' || raw === null) return out
  for (const [k, v] of Object.entries(raw)) {
    if (!FIELDS.has(k) || v === undefined) continue
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    out[k] = k === 'autoLayout' && typeof v === 'object' && v !== null ? normAutoLayout(v) : v
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

/** A deep copy of an element with fresh ids; elements come from the editor, so no field is dropped. */
function reId(el: El, budget: { left: number }, depth: number): El {
  if (budget.left-- <= 0) throw new Error(`At most ${MAX_ELEMENTS} elements`)
  if (depth > MAX_DEPTH + 4) throw new Error('The SVG nests too deeply')
  const { children, ...rest } = structuredClone(el) as El
  const copy: El = { ...rest, id: newId(String(el.type || 'el')) } as El
  if (Array.isArray(children)) copy.children = children.map((c) => reId(c, budget, depth + 1))
  return copy
}

function flatEls(els: El[]): El[] {
  return els.flatMap((e) => [e, ...(e.children ? flatEls(e.children) : [])])
}

function flatIds(els: El[]): string[] {
  return els.flatMap((e) => [e.id, ...(e.children ? flatIds(e.children) : [])])
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
    ...(isText
      ? {
          textContent: 'Text',
          fontFamily: 'Inter',
          fontSize: 18,
          fontWeight: 400,
          textAlign: 'left',
          textColor: '#000000',
          lineHeight: 1.4,
          letterSpacing: 0,
          textAutoResize: src.width === undefined ? 'hug' : 'grow',
        }
      : {}),
    ...props,
    id: newId(type),
    type,
    name:
      typeof props.name === 'string' && props.name
        ? props.name
        : type[0]!.toUpperCase() + type.slice(1),
  }
  if (Array.isArray(src.children) && src.children.length) {
    if (!CONTAINERS.has(type))
      throw new Error(`A ${type} cannot have children; use a frame or group`)
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
    out.fontWeight = el.fontWeight
    out.fontFamily = el.fontFamily
    out.textColor = el.textColor
    if (el.textAlign && el.textAlign !== 'left') out.textAlign = el.textAlign
    if (el.lineHeight) out.lineHeight = el.lineHeight
    if (el.letterSpacing) out.letterSpacing = el.letterSpacing
  } else if (typeof el.fill === 'string' && el.fill !== 'transparent') out.fill = el.fill
  if (typeof el.stroke === 'string' && el.stroke !== 'transparent') out.stroke = el.stroke
  if (el.cornerRadius) out.cornerRadius = el.cornerRadius
  if (el.strokeWidth) out.strokeWidth = el.strokeWidth
  if (typeof el.opacity === 'number' && el.opacity !== 100) out.opacity = el.opacity
  if (Array.isArray(el.shadows) && el.shadows.length) out.shadows = el.shadows
  if (Array.isArray(el.fills) && el.fills.length > 1) out.fills = el.fills
  if (el.visible === false) out.hidden = true
  if (el.autoLayout) out.autoLayout = el.autoLayout
  if (el.children?.length) {
    if (depth > 0) out.children = el.children.map((c) => summarize(c, depth - 1))
    else out.children = `${el.children.length} more (raise max_depth)`
  }
  return out
}

type LayoutIssue = { kind: string; parent: string; ids: string[]; detail: string }

/** Conservative geometry warnings, not automatic edits: overlapping artwork can be intentional. */
function checkLayout(page: Page): LayoutIssue[] {
  const issues: LayoutIssue[] = []
  const number = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const visit = (children: El[], parent?: El) => {
    const visible = children.filter(
      (e) => e.visible !== false && e.layoutPositioning !== 'absolute',
    )
    const parentId = parent?.id ?? page.id
    if (parent && parent.type === 'frame')
      for (const e of visible) {
        const x = number(e.x),
          y = number(e.y),
          w = number(e.width),
          h = number(e.height)
        if (
          x < -1 ||
          y < -1 ||
          x + w > number(parent.width) + 1 ||
          y + h > number(parent.height) + 1
        )
          issues.push({
            kind: 'overflow',
            parent: parentId,
            ids: [e.id],
            detail: 'Child extends outside its frame; check clipping or intentional bleed.',
          })
      }
    // Limit pair comparisons on very large sibling lists.
    if (visible.length <= 200)
      for (let i = 0; i < visible.length; i++)
        for (let j = i + 1; j < visible.length; j++) {
          const a = visible[i]!,
            b = visible[j]!
          const ax = number(a.x),
            ay = number(a.y),
            bx = number(b.x),
            by = number(b.y)
          const aw = number(a.width),
            ah = number(a.height),
            bw = number(b.width),
            bh = number(b.height)
          const ox = Math.min(ax + aw, bx + bw) - Math.max(ax, bx)
          const oy = Math.min(ay + ah, by + bh) - Math.max(ay, by)
          if (ox > 1 && oy > 1 && aw > 0 && ah > 0 && bw > 0 && bh > 0)
            issues.push({
              kind: 'overlap',
              parent: parentId,
              ids: [a.id, b.id],
              detail: 'Sibling bounds overlap; check whether this is intentional.',
            })
          else if (
            !parent?.autoLayout &&
            ox <= 0 &&
            oy > 0 &&
            Math.abs(ay - by) > 0.5 &&
            Math.abs(ay - by) <= 3
          )
            issues.push({
              kind: 'alignment',
              parent: parentId,
              ids: [a.id, b.id],
              detail: 'Top edges differ by at most 3px.',
            })
          else if (
            !parent?.autoLayout &&
            oy <= 0 &&
            ox > 0 &&
            Math.abs(ax - bx) > 0.5 &&
            Math.abs(ax - bx) <= 3
          )
            issues.push({
              kind: 'alignment',
              parent: parentId,
              ids: [a.id, b.id],
              detail: 'Left edges differ by at most 3px.',
            })
        }
    if (!parent?.autoLayout && visible.length >= 3 && visible.length <= 200) {
      for (const axis of ['x', 'y'] as const) {
        const cross = axis === 'x' ? 'y' : 'x',
          size = axis === 'x' ? 'width' : 'height'
        const sorted = [...visible].sort((a, b) => number(a[axis]) - number(b[axis]))
        for (let i = 0; i + 2 < sorted.length; i++) {
          const [a, b, c] = sorted.slice(i, i + 3) as [El, El, El]
          if (
            Math.max(number(a[cross]), number(b[cross]), number(c[cross])) -
              Math.min(number(a[cross]), number(b[cross]), number(c[cross])) >
            1
          )
            continue
          const g1 = number(b[axis]) - number(a[axis]) - number(a[size])
          const g2 = number(c[axis]) - number(b[axis]) - number(b[size])
          if (g1 >= 0 && g2 >= 0 && Math.abs(g1 - g2) > 1 && Math.abs(g1 - g2) <= 4)
            issues.push({
              kind: 'spacing',
              parent: parentId,
              ids: [a.id, b.id, c.id],
              detail: 'Adjacent gaps differ by 2 to 4px.',
            })
        }
      }
    }
    for (const e of children) if (e.children?.length) visit(e.children, e)
  }
  visit(page.elements)
  return issues
}

/** The design tools: they work on the host's designs directly, so no editor has to be open. */
export class DesignTools {
  constructor(
    private readonly designs: DesignStore,
    private readonly link?: DesignLink,
  ) {}

  /** The design the last call worked on, for the layout pass that follows an edit. */
  private lastDesign: string | undefined

  private resolve(args: Args): string {
    const given = typeof args.design === 'string' ? args.design : undefined
    const id = (() => {
      if (given) {
        if (!this.designs.get(given)) throw new Error(`No design ${given}. See design_list.`)
        return given
      }
      return this.designs.list()[0]?.id ?? this.designs.create('Untitled', 'agent').id
    })()
    this.lastDesign = id
    return id
  }

  /**
   * After an edit, a connected app works out auto layout and text sizes (it has the fonts and the
   * layout engine) and the result is saved, so design_read and the screenshots show real geometry.
   */
  private async settleLayout(): Promise<string | undefined> {
    const id = this.lastDesign
    const link = this.link
    if (!id || !link)
      return 'No connected layout service; positions and text sizes have not been verified.'
    const before = this.designs.get(id)
    if (!before) return
    const result = await link.layout(id)
    if (!result.ok) return `Layout was not computed: ${result.error}`
    const now = this.designs.get(id)
    // Someone else changed it meanwhile; their editor lays out its own edits.
    if (!now || now.rev !== before.rev)
      return 'Design changed during layout; re-read and verify geometry.'
    const changed = pagesOf(now.project).some((pg) => {
      const got = result.pages.find((p) => p.id === pg.id)
      return got !== undefined && JSON.stringify(got.elements) !== JSON.stringify(pg.elements)
    })
    if (!changed) return
    this.designs.mutate(
      id,
      (project) => {
        for (const pg of pagesOf(project)) {
          const got = result.pages.find((p) => p.id === pg.id)
          if (got) pg.elements = got.elements as El[]
        }
      },
      'agent',
    )
  }

  /** Like `call`, and also runs the tools that need an app to answer (pictures). */
  async callAsync(tool: DesignToolName, args: Args): Promise<DesignMcpResult> {
    let result: DesignMcpResult
    try {
      result =
        tool === 'design_add_svg'
          ? await this.addSvg(args)
          : tool === 'design_screenshot'
            ? await this.screenshot(args)
            : this.call(tool, args)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    if (!result.isError && MUTATING.has(tool)) {
      const layoutStatus = await this.settleLayout().catch(
        () => 'Layout failed; geometry has not been verified.',
      )
      const current = this.lastDesign && this.designs.get(this.lastDesign)
      if (current && result.content[0]?.type === 'text') {
        const issues = checkLayout(
          pageOf(current.project, typeof args.page === 'string' ? args.page : undefined),
        )
        if (issues.length || layoutStatus) {
          try {
            const body = JSON.parse(result.content[0].text)
            result.content[0].text = JSON.stringify({
              ...body,
              ...(layoutStatus ? { layoutStatus } : {}),
              layoutWarnings: issues.slice(0, 20),
              layoutWarningCount: issues.length,
            })
          } catch {
            /* Preserve non-JSON results. */
          }
        }
      }
    }
    return result
  }

  private async addSvg(args: Args): Promise<DesignMcpResult> {
    if (!this.link) return fail('SVG import is not available on this host.')
    const id = this.resolve(args)
    const svg = typeof args.svg === 'string' ? args.svg.trim() : ''
    if (!svg.startsWith('<') || !/<svg[\s>]/i.test(svg))
      throw new Error('svg must be a complete <svg> element')
    const color = typeof args.color === 'string' && args.color ? args.color : '#000000'
    const width = Number(args.width)
    const result = await this.link.importSvg(
      svg.replace(/currentColor/g, color),
      Number.isFinite(width) && width > 0 ? width : undefined,
    )
    if (!result.ok) return fail(result.error)
    const root = result.elements[0] as El | undefined
    if (!root || typeof root !== 'object')
      throw new Error('The SVG had no shapes the editor could draw')
    const made = reId(root, { left: MAX_ELEMENTS }, 0)
    made.x = Number.isFinite(Number(args.x)) ? Number(args.x) : 0
    made.y = Number.isFinite(Number(args.y)) ? Number(args.y) : 0
    made.name = typeof args.name === 'string' && args.name ? args.name : 'Icon'
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
          hit.el.children = [...(hit.el.children ?? []), made]
        } else pg.elements.push(made)
      },
      'agent',
      flatIds([made]),
    )
    return ok({ design: id, added: made.id, width: made.width, height: made.height })
  }

  private async screenshot(args: Args): Promise<DesignMcpResult> {
    if (!this.link) return fail('Pictures of designs are not available on this host.')
    const id = this.resolve(args)
    const d = this.designs.get(id)!
    const pg = pageOf(d.project, typeof args.page === 'string' ? args.page : undefined)
    const elementId = typeof args.element === 'string' ? args.element : undefined
    if (elementId && !find(pg.elements, elementId))
      throw new Error(`No element ${elementId} on page ${pg.id}`)
    const scale = Math.min(Math.max(Number(args.scale) || 1, 0.25), 2)
    const result = await this.link.render({ designId: id, pageId: pg.id, elementId, scale })
    if (!result.ok) return fail(result.error)
    return {
      content: [
        {
          type: 'text',
          text: `${d.name}, page ${pg.name}${elementId ? `, element ${elementId}` : ''}. Now compare this with what was asked for: list each difference (size, spacing, colour, weight, alignment, missing or crude icons) and fix them, then take another picture.`,
        },
        { type: 'image', data: result.image.data, mimeType: result.image.mime },
      ],
    }
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
      case 'design_screenshot':
      case 'design_add_svg':
        throw new Error(`${tool} needs callAsync`)
      case 'design_duplicate': {
        const id = this.resolve(args)
        const elId = String(args.id ?? '')
        const count = Math.min(Math.max(Math.floor(Number(args.count) || 1), 1), 20)
        const dx = Number(args.dx) || 0
        const dy = Number(args.dy) || 0
        const added: string[] = []
        const touched: string[] = []
        this.designs.mutate(
          id,
          (project) => {
            for (const pg of pagesOf(project)) {
              const hit = find(pg.elements, elId)
              if (!hit) continue
              const budget = { left: MAX_ELEMENTS }
              let at = hit.siblings.indexOf(hit.el)
              for (let i = 1; i <= count; i++) {
                const copy = reId(hit.el, budget, 0)
                copy.x = Number(hit.el.x) + dx * i
                copy.y = Number(hit.el.y) + dy * i
                hit.siblings.splice(++at, 0, copy)
                added.push(copy.id)
                touched.push(...flatIds([copy]))
              }
              return
            }
            throw new Error(`No element with id ${elId}`)
          },
          'agent',
          touched,
        )
        return { design: id, added }
      }
      case 'design_move': {
        const id = this.resolve(args)
        const elId = String(args.id ?? '')
        this.designs.mutate(
          id,
          (project) => {
            let pg: Page | undefined
            let hit: ReturnType<typeof find>
            for (const candidate of pagesOf(project)) {
              hit = find(candidate.elements, elId)
              if (hit) {
                pg = candidate
                break
              }
            }
            if (!hit || !pg) throw new Error(`No element with id ${elId}`)
            let target = hit.siblings
            if (typeof args.parent === 'string' && args.parent) {
              if (args.parent === 'page') target = pg.elements
              else {
                const dest = find(pg.elements, args.parent)
                if (!dest) throw new Error(`No element ${args.parent}`)
                if (!CONTAINERS.has(dest.el.type))
                  throw new Error(`${args.parent} is a ${dest.el.type}, not a frame or group`)
                if (find([hit.el], args.parent))
                  throw new Error('An element cannot be moved into itself')
                dest.el.children = dest.el.children ?? []
                target = dest.el.children
              }
            }
            hit.siblings.splice(hit.siblings.indexOf(hit.el), 1)
            const at = Number.isFinite(Number(args.index))
              ? Math.min(Math.max(Math.floor(Number(args.index)), 0), target.length)
              : target.length
            target.splice(at, 0, hit.el)
            if (Number.isFinite(Number(args.x))) hit.el.x = Number(args.x)
            if (Number.isFinite(Number(args.y))) hit.el.y = Number(args.y)
          },
          'agent',
          [elId],
        )
        return { design: id, moved: elId }
      }
      case 'design_check_layout': {
        const id = this.resolve(args)
        const pg = pageOf(
          this.designs.get(id)!.project,
          typeof args.page === 'string' ? args.page : undefined,
        )
        const issues = checkLayout(pg)
        return {
          design: id,
          page: pg.id,
          issues: issues.slice(0, 100),
          issueCount: issues.length,
          note: 'Warnings may be intentional; verify against the rendered design. Auto-layout and text geometry require a connected editor.',
        }
      }
      case 'design_arrange': {
        const id = this.resolve(args)
        const ids = Array.isArray(args.ids) ? [...new Set(args.ids.map(String))] : []
        const operation = String(args.operation ?? '')
        const allowed = [
          'left',
          'center-x',
          'right',
          'top',
          'center-y',
          'bottom',
          'distribute-x',
          'distribute-y',
          'snap',
        ]
        if (
          !allowed.includes(operation) ||
          ids.length < (operation.startsWith('distribute') ? 3 : operation === 'snap' ? 1 : 2)
        )
          throw new Error('Invalid operation or too few distinct element ids')
        const grid = args.grid === undefined ? 8 : Number(args.grid)
        if (operation === 'snap' && (!Number.isFinite(grid) || grid <= 0))
          throw new Error('grid must be a positive number')
        this.designs.mutate(
          id,
          (project) => {
            const pg = pageOf(project, typeof args.page === 'string' ? args.page : undefined)
            const hits = ids.map((elementId) => find(pg.elements, elementId))
            if (hits.some((hit) => !hit))
              throw new Error('All elements must exist on the selected page')
            const siblings = hits[0]!.siblings
            if (hits.some((hit) => hit!.siblings !== siblings))
              throw new Error('Elements must share the same parent')
            const parent = flatEls(pg.elements).find((el) => el.children === siblings)
            if (parent?.autoLayout && hits.some((hit) => hit!.el.layoutPositioning !== 'absolute'))
              throw new Error(
                'Arrange auto-layout children via their parent; only absolute children can be arranged',
              )
            const els = hits.map((hit) => hit!.el)
            if (
              els.some(
                (el) =>
                  el.locked ||
                  !['x', 'y', 'width', 'height'].every(
                    (key) => typeof el[key] === 'number' && Number.isFinite(el[key]),
                  ),
              )
            )
              throw new Error('Elements must be unlocked and have finite bounds')
            const n = (el: El, key: string) => el[key] as number
            if (operation === 'snap')
              for (const el of els) {
                el.x = Math.round(n(el, 'x') / grid) * grid
                el.y = Math.round(n(el, 'y') / grid) * grid
              }
            else if (operation.startsWith('distribute')) {
              const axis = operation.endsWith('x') ? 'x' : 'y',
                size = axis === 'x' ? 'width' : 'height'
              els.sort((a, b) => n(a, axis) - n(b, axis))
              const first = n(els[0]!, axis),
                last = n(els[els.length - 1]!, axis) + n(els[els.length - 1]!, size)
              const gap =
                (last - first - els.reduce((sum, el) => sum + n(el, size), 0)) / (els.length - 1)
              let cursor = first
              for (const el of els) {
                el[axis] = cursor
                cursor += n(el, size) + gap
              }
            } else {
              const axis = ['left', 'center-x', 'right'].includes(operation) ? 'x' : 'y',
                size = axis === 'x' ? 'width' : 'height'
              const factor = operation.startsWith('center')
                ? 0.5
                : ['right', 'bottom'].includes(operation)
                  ? 1
                  : 0
              const anchor = n(els[0]!, axis) + n(els[0]!, size) * factor
              for (const el of els.slice(1)) el[axis] = anchor - n(el, size) * factor
            }
          },
          'agent',
          ids,
        )
        return { design: id, arranged: ids, operation }
      }
      case 'design_search_knowledge':
        return searchDesignKnowledge(args.query, args.domain, args.limit)
      case 'design_skill':
        return designSkill(args.name)
      case 'design_get_selection': {
        const view = this.link?.current()
        const d = view?.designId ? this.designs.get(view.designId) : undefined
        if (!view || !d)
          return 'Nothing is open in a Design screen right now, so nothing is selected.'
        const pg = pageOf(d.project, view.pageId)
        const picked = view.selection
          .map((sel) => find(pg.elements, sel)?.el)
          .filter((e): e is El => e !== undefined)
        if (!picked.length)
          return { design: d.id, page: pg.id, selected: [], note: 'Nothing is selected.' }
        return { design: d.id, page: pg.id, selected: picked.map((e) => summarize(e, 2)) }
      }
      case 'design_list':
        return { designs: this.designs.list() }
      case 'design_create': {
        const d = this.designs.create(
          typeof args.name === 'string' ? args.name : undefined,
          'agent',
        )
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
          pages: pagesOf(d.project).map((p) => ({
            id: p.id,
            name: p.name,
            elements: p.elements.length,
          })),
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
          flatIds(made),
        )
        const ids = (els: El[]): unknown[] =>
          els.map((e) => (e.children?.length ? { id: e.id, children: ids(e.children) } : e.id))
        const flat = flatEls(made)
        const iconish = flat.filter(
          (e) =>
            /icon|glyph|logo|chevron|caret|close|search|check|arrow|rail/i.test(
              String(e.name ?? ''),
            ) ||
            (e.type === 'text' && /^[^\p{L}\p{N}\s]{1,2}$/u.test(String(e.textContent ?? ''))),
        )
        const loose = flat.filter(
          (e) =>
            e.type === 'frame' &&
            !e.autoLayout &&
            (e.children?.length ?? 0) >= 3 &&
            e.children!.every((c) => c.layoutPositioning !== 'absolute'),
        )
        return {
          design: id,
          added: ids(made),
          ...(loose.length
            ? {
                layoutHint: `Frames like ${loose
                  .slice(0, 3)
                  .map((e) => `"${e.name}"`)
                  .join(
                    ', ',
                  )} hold several children placed by hand. If they are a row, list or stack, give the frame autoLayout (design_update) and drop the children's x/y, so spacing stays even.`,
              }
            : {}),
          ...(iconish.length
            ? {
                hint: `Elements like ${iconish
                  .slice(0, 3)
                  .map((e) => `"${e.name}"`)
                  .join(
                    ', ',
                  )} look like icons. Real icons should be vector shapes drawn with design_add_svg, not rectangles, ellipses or characters; replace them.`,
              }
            : {}),
        }
      }
      case 'design_update': {
        const id = this.resolve(args)
        if (!Array.isArray(args.updates) || !args.updates.length)
          throw new Error('updates must be a non-empty array')
        const missing: string[] = []
        const touched: string[] = []
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
              if (typeof raw.autoLayout === 'object' && raw.autoLayout !== null)
                props.autoLayout = normAutoLayout(raw.autoLayout, hit.el.autoLayout)
              delete props.type
              Object.assign(hit.el, props)
              touched.push(elId)
            }
          },
          'agent',
          touched,
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
