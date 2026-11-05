import { randomBytes } from 'node:crypto'
import { estimateBBox } from './bboxEstimate.ts'
import type { CadDocument, CadFeature, CadSketch, CadStore } from './cadStore.ts'
import { NEEDS_CAD_PANE, type CadLink } from './cadLink.ts'

export const CAD_TOOL_NAMES = [
  'cad_list',
  'cad_create',
  'cad_get_tree',
  'cad_add_sketch',
  'cad_add_feature',
  'cad_edit_feature',
  'cad_delete_feature',
  'cad_set_params',
  'cad_query_geometry',
  'cad_screenshot',
  'cad_import',
  'cad_export',
] as const
export type CadToolName = (typeof CAD_TOOL_NAMES)[number]
export const isCadToolName = (name: string): name is CadToolName =>
  (CAD_TOOL_NAMES as readonly string[]).includes(name)

const FEATURE_TYPES = new Set([
  'box',
  'cylinder',
  'sphere',
  'extrude',
  'revolve',
  'fillet',
  'chamfer',
  'union',
  'cut',
  'intersect',
  'import',
])
const IMPORT_FORMATS = new Set(['step', 'stp', 'stl', 'iges', 'igs', 'json'])
const EXPORT_FORMATS = new Set(['step', 'stp', 'stl', 'json'])
const FEATURE_ID = /^[\w-]{1,64}$/
const QUERY_KINDS = new Set(['bbox', 'volume', 'area', 'center'])
const MAX_FEATURES = 500
const MAX_SKETCHES = 200
const MAX_ENTITIES = 2000
const MAX_IMPORT = 8_000_000

/** Tools that change a document. After they succeed, a connected pane rebuilds the solid. */
const MUTATING: ReadonlySet<string> = new Set([
  'cad_add_sketch',
  'cad_add_feature',
  'cad_edit_feature',
  'cad_delete_feature',
  'cad_set_params',
  'cad_import',
])

const documentId = {
  type: 'string',
  description: 'Document id from cad_list. Omit to use the most recently changed document.',
}

/** The tools, as MCP lists them. */
export const CAD_TOOL_DEFINITIONS = [
  {
    name: 'cad_list',
    description: 'Lists the CAD documents on this host, most recently changed first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cad_create',
    description: 'Creates a new, empty CAD document in millimetres and returns its id.',
    inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
  },
  {
    name: 'cad_get_tree',
    description:
      'Reads a CAD document: its sketches, parameters, and features in history order. Features at an index below historyIndex are active. Read this before changing a model you did not just create.',
    inputSchema: { type: 'object', properties: { document: documentId } },
  },
  {
    name: 'cad_add_sketch',
    description:
      'Adds a sketch on a plane (XY, YZ or ZX, or a short plane name). entities is a list of plain objects (lines, circles, arcs) the pane can draw. Returns the sketch id.',
    inputSchema: {
      type: 'object',
      properties: {
        document: documentId,
        name: { type: 'string' },
        plane: { type: 'string', description: 'XY, YZ, ZX, or a short plane name. Default XY.' },
        entities: { type: 'array', items: { type: 'object' } },
      },
    },
  },
  {
    name: 'cad_add_feature',
    description:
      'Appends a feature and makes it the current history tip (features after the old tip are dropped). type is box, cylinder, sphere, extrude, revolve, fillet, chamfer, union, cut, intersect, or import. params holds sizes in millimetres. extrude and revolve take a sketch id. Returns the feature id. The user sees it in the CAD pane.',
    inputSchema: {
      type: 'object',
      properties: {
        document: documentId,
        type: {
          type: 'string',
          enum: [
            'box',
            'cylinder',
            'sphere',
            'extrude',
            'revolve',
            'fillet',
            'chamfer',
            'union',
            'cut',
            'intersect',
            'import',
          ],
        },
        name: { type: 'string' },
        sketch: { type: 'string', description: 'Sketch id for extrude or revolve.' },
        params: {
          type: 'object',
          description:
            'Sizes in millimetres. Box: width, depth, height. Cylinder: radius, height. Sphere: radius. Extrude: distance. Revolve: angle. Fillet and chamfer: radius. Booleans: target ids in a targets array.',
        },
        suppressed: { type: 'boolean' },
      },
      required: ['type'],
    },
  },
  {
    name: 'cad_edit_feature',
    description:
      'Changes one feature by id: name, params (merged; null deletes a key), sketch, or suppressed. The type stays as it is.',
    inputSchema: {
      type: 'object',
      properties: {
        document: documentId,
        id: { type: 'string' },
        name: { type: 'string' },
        sketch: { type: 'string', description: 'Sketch id, or null to clear it.' },
        params: { type: 'object' },
        suppressed: { type: 'boolean' },
      },
      required: ['id'],
    },
  },
  {
    name: 'cad_delete_feature',
    description: 'Deletes one feature by id and pulls the history cursor back if it was active.',
    inputSchema: {
      type: 'object',
      properties: { document: documentId, id: { type: 'string' } },
      required: ['id'],
    },
  },
  {
    name: 'cad_set_params',
    description:
      'Merges named parameters onto the document (sizes shared by features). A null value deletes that parameter. Values are numbers, strings, booleans, or plain objects.',
    inputSchema: {
      type: 'object',
      properties: { document: documentId, params: { type: 'object' } },
      required: ['params'],
    },
  },
  {
    name: 'cad_query_geometry',
    description:
      'Measures the rebuilt solid: bbox, volume, area, or center, for the whole model or one feature. Uses the CAD pane when it is open. If it is not, bbox is an estimate from feature parameters and is labeled approximate; volume, area and center need the pane. Do not treat an approximate bbox as a rebuilt measurement.',
    inputSchema: {
      type: 'object',
      properties: {
        document: documentId,
        feature: { type: 'string', description: 'Feature id. The whole model if omitted.' },
        what: { type: 'string', enum: ['bbox', 'volume', 'area', 'center'] },
      },
    },
  },
  {
    name: 'cad_screenshot',
    description:
      'Draws the model (or one feature) to a PNG and returns it. Needs the CAD pane open on this host. Look at it after a change and fix what is wrong. If the pane is not open, say so.',
    inputSchema: {
      type: 'object',
      properties: {
        document: documentId,
        feature: {
          type: 'string',
          description: 'Feature id to draw alone. The whole model if omitted.',
        },
        scale: { type: 'number', description: 'Pixel scale, 0.25 to 2 (default 1).' },
      },
    },
  },
  {
    name: 'cad_import',
    description:
      'Imports a file into the document. format json reads a CAD document on this host. format step, stp, stl, iges or igs needs the CAD pane to read the file. data is the file text or base64. Returns the new feature ids.',
    inputSchema: {
      type: 'object',
      properties: {
        document: documentId,
        format: { type: 'string', enum: ['step', 'stp', 'stl', 'iges', 'igs', 'json'] },
        data: { type: 'string' },
        filename: { type: 'string' },
      },
      required: ['format', 'data'],
    },
  },
  {
    name: 'cad_export',
    description:
      'Exports the model (or one feature). format json writes the document stored on this host. format step, stp or stl needs the CAD pane, or bytes the pane already stored, and returns the file as base64 or text.',
    inputSchema: {
      type: 'object',
      properties: {
        document: documentId,
        format: { type: 'string', enum: ['step', 'stp', 'stl', 'json'] },
        feature: { type: 'string' },
      },
      required: ['format'],
    },
  },
] as const

export const CAD_INSTRUCTIONS = `BeddCode CAD. The user is asking you to create or edit a solid model on the CAD pane. Use the BeddCode CAD tools (cad_list, cad_create, cad_get_tree, cad_add_sketch, cad_add_feature, cad_edit_feature, cad_delete_feature, cad_set_params, cad_query_geometry, cad_screenshot, cad_import, cad_export), not a mesh file or code, unless the user explicitly asks for a file. Units are millimetres. If the CAD tools are unavailable, explain that; do not substitute a file.

Read cad_get_tree before changing a document you did not just create. Add sketches on a plane (XY, YZ or ZX), then features (box, cylinder, sphere, extrude, revolve, fillet, chamfer, union, cut, intersect). After an edit the pane rebuilds the solid when it is open. cad_screenshot needs that pane. cad_query_geometry uses it when it is open; a bbox without the pane is only an estimate from feature parameters. cad_export of JSON is the document on the host; STEP and STL need the pane. If a tool says it needs an open CAD pane, say so instead of claiming you checked or exported the solid.`

type Args = Record<string, unknown>
export interface CadMcpResult {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  isError?: boolean
}

const ok = (value: unknown): CadMcpResult => ({
  content: [
    { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
  ],
})
const fail = (text: string): CadMcpResult => ({
  content: [{ type: 'text', text }],
  isError: true,
})

const newId = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex')}`

/** A JSON value safe to store. Drops functions and prototype keys. */
function plain(value: unknown, depth = 0): unknown {
  if (depth > 6) return undefined
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'string') return value.length > 10_000 ? value.slice(0, 10_000) : value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value))
    return value
      .slice(0, MAX_ENTITIES)
      .map((v) => plain(v, depth + 1))
      .filter((v) => v !== undefined)
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue
      if (!key || key.length > 64) continue
      const next = plain(inner, depth + 1)
      if (next !== undefined) out[key] = next
    }
    return out
  }
  return undefined
}

function plainObject(value: unknown): Record<string, unknown> | undefined {
  const next = plain(value)
  if (!next || typeof next !== 'object' || Array.isArray(next)) return undefined
  return next as Record<string, unknown>
}

function nameOf(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 80) : fallback
}

function buildFeature(raw: Args): CadFeature {
  const type = typeof raw.type === 'string' ? raw.type : ''
  if (!FEATURE_TYPES.has(type))
    throw new Error(
      `Unknown feature type ${type || '(missing)'}. Use box, cylinder, sphere, extrude, revolve, fillet, chamfer, union, cut, intersect, or import.`,
    )
  const params = raw.params === undefined ? {} : plainObject(raw.params)
  if (!params) throw new Error('params must be an object')
  const feature: CadFeature = {
    id: newId(type),
    type,
    name: nameOf(raw.name, type),
    params,
  }
  if (typeof raw.sketch === 'string' && raw.sketch) feature.sketchId = raw.sketch
  if (raw.suppressed === true) feature.suppressed = true
  return feature
}

function buildSketch(raw: Args): CadSketch {
  const entities = Array.isArray(raw.entities) ? plain(raw.entities.slice(0, MAX_ENTITIES)) : []
  const plane =
    typeof raw.plane === 'string' && raw.plane.trim() ? raw.plane.trim().slice(0, 32) : 'XY'
  return {
    id: newId('sketch'),
    name: nameOf(raw.name, 'Sketch'),
    plane,
    entities: Array.isArray(entities) ? entities : [],
  }
}

function treeOf(doc: CadDocument) {
  return {
    document: doc.id,
    name: doc.name,
    rev: doc.rev,
    units: doc.units,
    historyIndex: doc.historyIndex,
    params: doc.params,
    sketches: doc.sketches.map((s) => ({
      id: s.id,
      name: s.name,
      plane: s.plane,
      entities: s.entities.length,
    })),
    features: doc.features.map((f, index) => ({
      id: f.id,
      type: f.type,
      name: f.name,
      params: f.params,
      ...(f.sketchId ? { sketchId: f.sketchId } : {}),
      ...(f.suppressed ? { suppressed: true } : {}),
      index,
      active: index < doc.historyIndex && f.suppressed !== true,
    })),
  }
}

/** The CAD tools: they work on the host's documents directly, so no pane has to be open to edit. */
export class CadTools {
  /** The document the last call worked on, for the rebuild that follows an edit. */
  private lastDocument: string | undefined

  constructor(
    private readonly documents: CadStore,
    private readonly link?: CadLink,
  ) {
    // WebSocket clients already get `cad.changed` from the host. This forwards the same notice
    // to an in-process pane so it rebuilds the document the tool just wrote.
    this.documents.onChange((change) => this.link?.publish(change))
  }

  private resolve(args: Args): string {
    const given = typeof args.document === 'string' ? args.document : undefined
    const id = (() => {
      if (given) {
        if (!this.documents.get(given)) throw new Error(`No CAD document ${given}. See cad_list.`)
        return given
      }
      return this.documents.list()[0]?.id ?? this.documents.create('Untitled', 'agent').id
    })()
    this.lastDocument = id
    return id
  }

  /**
   * After an edit, a connected pane rebuilds the solid (it has the geometry kernel) so the next
   * screenshot and measurement match the document.
   */
  private async settle(): Promise<string | undefined> {
    const id = this.lastDocument
    const link = this.link
    if (!id || !link)
      return 'Needs an open CAD pane with a renderer; geometry has not been rebuilt.'
    const doc = this.documents.get(id)
    if (!doc) return
    const result = await link.rebuild({ documentId: id, document: doc })
    if (!result.ok) return `Geometry was not rebuilt: ${result.error}`
  }

  /** Like `call`, and also runs the tools that need a pane to answer. */
  async callAsync(tool: CadToolName, args: Args): Promise<CadMcpResult> {
    let result: CadMcpResult
    try {
      result =
        tool === 'cad_screenshot'
          ? await this.screenshot(args)
          : tool === 'cad_query_geometry'
            ? await this.query(args)
            : tool === 'cad_import'
              ? await this.importFile(args)
              : tool === 'cad_export'
                ? await this.exportFile(args)
                : this.call(tool, args)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
    if (!result.isError && MUTATING.has(tool)) {
      const rebuildStatus = await this.settle().catch(
        () => 'Rebuild failed; geometry has not been rebuilt.',
      )
      if (rebuildStatus && result.content[0]?.type === 'text') {
        try {
          const body = JSON.parse(result.content[0].text)
          result.content[0].text = JSON.stringify({ ...body, rebuildStatus })
        } catch {
          /* Preserve non-JSON results. */
        }
      }
    }
    return result
  }

  private featureOf(doc: CadDocument, id: string | undefined): CadFeature | undefined {
    if (!id) return undefined
    return doc.features.find((f) => f.id === id)
  }

  private async screenshot(args: Args): Promise<CadMcpResult> {
    if (!this.link)
      return fail(`${NEEDS_CAD_PANE} Pictures of CAD models are not available on this host.`)
    const id = this.resolve(args)
    const doc = this.documents.get(id)!
    const featureId = typeof args.feature === 'string' ? args.feature : undefined
    if (featureId && !this.featureOf(doc, featureId)) throw new Error(`No feature ${featureId}`)
    const scale = Math.min(Math.max(Number(args.scale) || 1, 0.25), 2)
    const result = await this.link.render({ documentId: id, document: doc, featureId, scale })
    if (!result.ok) return fail(result.error)
    return {
      content: [
        {
          type: 'text',
          text: `${doc.name}${featureId ? `, feature ${featureId}` : ''}. Compare this picture with what was asked for and fix the model if it differs.`,
        },
        { type: 'image', data: result.image.data, mimeType: result.image.mime },
      ],
    }
  }

  private async query(args: Args): Promise<CadMcpResult> {
    const id = this.resolve(args)
    const doc = this.documents.get(id)!
    const featureId = typeof args.feature === 'string' ? args.feature : undefined
    if (featureId && !this.featureOf(doc, featureId)) throw new Error(`No feature ${featureId}`)
    const what = typeof args.what === 'string' && args.what ? args.what : 'bbox'
    if (!QUERY_KINDS.has(what))
      throw new Error(`Unknown measurement ${what}. Use bbox, volume, area, or center.`)
    let paneError = NEEDS_CAD_PANE
    if (this.link) {
      const result = await this.link.query({ documentId: id, document: doc, featureId, what })
      if (result.ok)
        return ok({ document: id, feature: featureId, what, geometry: result.geometry })
      paneError = result.error
    }
    if (what === 'bbox') {
      const geometry = estimateBBox(doc, featureId)
      if (geometry) {
        return ok({
          document: id,
          ...(featureId ? { feature: featureId } : {}),
          what,
          geometry,
          accuracy: 'approximate',
          source: 'feature-params',
          note: 'Estimated from stored feature parameters. Not a measurement of the rebuilt solid.',
        })
      }
    }
    return fail(paneError)
  }

  private async importFile(args: Args): Promise<CadMcpResult> {
    const id = this.resolve(args)
    const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : ''
    if (!IMPORT_FORMATS.has(format))
      throw new Error('format must be json, step, stp, stl, iges, or igs')
    const data = typeof args.data === 'string' ? args.data : ''
    if (!data.trim()) throw new Error('data must be the file text or base64')
    if (data.length > MAX_IMPORT) throw new Error('Import data is too large')
    if (format === 'json') return this.importJson(id, data)
    if (!this.link) return paneJob('import', NEEDS_CAD_PANE, { format, document: id })
    const filename = typeof args.filename === 'string' ? args.filename.slice(0, 200) : undefined
    const result = await this.link.requestImport({ format, data, filename, documentId: id })
    if (!result.ok) return paneJob('import', result.error, { format, document: id })
    const sketches = result.sketches
      .map((raw) => (raw && typeof raw === 'object' ? buildSketch(raw as Args) : undefined))
      .filter((s): s is CadSketch => s !== undefined)
    const features = result.features
      .map((raw) => (raw && typeof raw === 'object' ? buildFeature(raw as Args) : undefined))
      .filter((f): f is CadFeature => f !== undefined)
    if (!features.length && !sketches.length)
      throw new Error('The file had no features the CAD pane could read')
    this.documents.mutate(
      id,
      (doc) => {
        if (doc.sketches.length + sketches.length > MAX_SKETCHES)
          throw new Error(`A document can hold ${MAX_SKETCHES} sketches`)
        doc.features = doc.features.slice(
          0,
          Math.min(Math.max(0, doc.historyIndex), doc.features.length),
        )
        if (doc.features.length + features.length > MAX_FEATURES)
          throw new Error(`A document can hold ${MAX_FEATURES} features`)
        doc.sketches.push(...sketches)
        doc.features.push(...features)
        doc.historyIndex = doc.features.length
      },
      'agent',
      [...sketches.map((s) => s.id), ...features.map((f) => f.id)],
    )
    return ok({
      document: id,
      sketches: sketches.map((s) => s.id),
      features: features.map((f) => f.id),
    })
  }

  private async exportFile(args: Args): Promise<CadMcpResult> {
    const id = this.resolve(args)
    const doc = this.documents.get(id)!
    const format = typeof args.format === 'string' ? args.format.trim().toLowerCase() : ''
    if (!EXPORT_FORMATS.has(format)) throw new Error('format must be json, step, stp, or stl')
    const featureId = typeof args.feature === 'string' ? args.feature : undefined
    if (featureId && !this.featureOf(doc, featureId)) throw new Error(`No feature ${featureId}`)
    if (format === 'json') {
      const body = documentForExport(doc, featureId)
      return ok({
        document: id,
        format: 'json',
        mime: 'application/json',
        filename: exportName(doc.name, 'json'),
        encoding: 'utf-8',
        data: JSON.stringify(body),
      })
    }
    if (!this.link)
      return paneJob('export', NEEDS_CAD_PANE, { format, document: id, feature: featureId })
    const result = await this.link.requestExport(format, {
      documentId: id,
      document: doc,
      featureId,
    })
    if (!result.ok) {
      return paneJob('export', result.error, { format, document: id, feature: featureId })
    }
    return ok({
      document: id,
      format,
      mime: result.file.mime,
      filename: result.file.filename ?? exportName(doc.name, format),
      data: result.file.data,
    })
  }

  /** JSON documents are applied on the host. STEP and STL still go through the pane. */
  private importJson(id: string, data: string): CadMcpResult {
    const parsed = parseJsonDocument(data)
    const current = this.documents.get(id)!
    const taken = new Set<string>([
      ...current.sketches.map((sketch) => sketch.id),
      ...current.features.map((feature) => feature.id),
    ])
    const sketches = parsed.sketches
      .map((raw) => copySketch(raw, taken))
      .filter((sketch): sketch is CadSketch => sketch !== undefined)
    const features = parsed.features
      .map((raw) => copyFeature(raw, taken))
      .filter((feature): feature is CadFeature => feature !== undefined)
    if (!features.length && !sketches.length)
      throw new Error('The JSON document had no features or sketches')
    this.documents.mutate(
      id,
      (doc) => {
        if (doc.sketches.length + sketches.length > MAX_SKETCHES)
          throw new Error(`A document can hold ${MAX_SKETCHES} sketches`)
        doc.features = doc.features.slice(
          0,
          Math.min(Math.max(0, doc.historyIndex), doc.features.length),
        )
        if (doc.features.length + features.length > MAX_FEATURES)
          throw new Error(`A document can hold ${MAX_FEATURES} features`)
        doc.sketches.push(...sketches)
        doc.features.push(...features)
        doc.historyIndex = doc.features.length
      },
      'agent',
      [...sketches.map((sketch) => sketch.id), ...features.map((feature) => feature.id)],
    )
    return ok({
      document: id,
      sketches: sketches.map((sketch) => sketch.id),
      features: features.map((feature) => feature.id),
    })
  }

  call(tool: CadToolName, args: Args): CadMcpResult {
    try {
      return ok(this.run(tool, args))
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  }

  private run(tool: CadToolName, args: Args): unknown {
    switch (tool) {
      case 'cad_screenshot':
      case 'cad_query_geometry':
      case 'cad_import':
      case 'cad_export':
        throw new Error(`${tool} needs callAsync`)
      case 'cad_list':
        return { documents: this.documents.list() }
      case 'cad_create': {
        const doc = this.documents.create(
          typeof args.name === 'string' ? args.name : undefined,
          'agent',
        )
        this.lastDocument = doc.id
        return { id: doc.id, name: doc.name, units: doc.units }
      }
      case 'cad_get_tree': {
        const id = this.resolve(args)
        return treeOf(this.documents.get(id)!)
      }
      case 'cad_add_sketch': {
        const id = this.resolve(args)
        const sketch = buildSketch(args)
        this.documents.mutate(
          id,
          (doc) => {
            if (doc.sketches.length >= MAX_SKETCHES)
              throw new Error(`A document can hold ${MAX_SKETCHES} sketches`)
            doc.sketches.push(sketch)
          },
          'agent',
          [sketch.id],
        )
        return { document: id, sketch: sketch.id, plane: sketch.plane }
      }
      case 'cad_add_feature': {
        const id = this.resolve(args)
        const made = buildFeature(args)
        this.documents.mutate(
          id,
          (doc) => {
            if (made.sketchId && !doc.sketches.some((s) => s.id === made.sketchId))
              throw new Error(`No sketch ${made.sketchId}`)
            const at = Math.min(Math.max(0, doc.historyIndex), doc.features.length)
            doc.features = doc.features.slice(0, at)
            if (doc.features.length >= MAX_FEATURES)
              throw new Error(`A document can hold ${MAX_FEATURES} features`)
            doc.features.push(made)
            doc.historyIndex = doc.features.length
          },
          'agent',
          [made.id],
        )
        return {
          document: id,
          feature: made.id,
          type: made.type,
          historyIndex: this.documents.get(id)!.historyIndex,
        }
      }
      case 'cad_edit_feature': {
        const id = this.resolve(args)
        const featureId = typeof args.id === 'string' ? args.id : ''
        if (!featureId) throw new Error('id is required')
        this.documents.mutate(
          id,
          (doc) => {
            const feature = doc.features.find((f) => f.id === featureId)
            if (!feature) throw new Error(`No feature ${featureId}`)
            if (typeof args.type === 'string' && args.type !== feature.type)
              throw new Error('Feature type cannot be changed')
            if (typeof args.name === 'string' && args.name.trim())
              feature.name = args.name.trim().slice(0, 80)
            if (args.suppressed !== undefined) feature.suppressed = args.suppressed === true
            if (args.sketch === null) delete feature.sketchId
            else if (typeof args.sketch === 'string' && args.sketch) {
              if (!doc.sketches.some((s) => s.id === args.sketch))
                throw new Error(`No sketch ${args.sketch}`)
              feature.sketchId = args.sketch
            }
            if (args.params !== undefined) {
              const extra = plainObject(args.params)
              if (!extra) throw new Error('params must be an object')
              for (const [key, value] of Object.entries(extra)) {
                if (value === null) delete feature.params[key]
                else feature.params[key] = value
              }
            }
          },
          'agent',
          [featureId],
        )
        return { document: id, feature: featureId }
      }
      case 'cad_delete_feature': {
        const id = this.resolve(args)
        const featureId = typeof args.id === 'string' ? args.id : ''
        if (!featureId) throw new Error('id is required')
        let removed = false
        this.documents.mutate(
          id,
          (doc) => {
            const index = doc.features.findIndex((f) => f.id === featureId)
            if (index < 0) throw new Error(`No feature ${featureId}`)
            doc.features.splice(index, 1)
            if (index < doc.historyIndex) doc.historyIndex -= 1
            removed = true
          },
          'agent',
          [featureId],
        )
        return { document: id, removed: removed ? featureId : undefined }
      }
      case 'cad_set_params': {
        const id = this.resolve(args)
        const extra = plainObject(args.params)
        if (!extra) throw new Error('params must be an object')
        this.documents.mutate(
          id,
          (doc) => {
            for (const [key, value] of Object.entries(extra)) {
              if (value === null) delete doc.params[key]
              else doc.params[key] = value
            }
          },
          'agent',
        )
        return { document: id, params: this.documents.get(id)!.params }
      }
    }
  }
}

/** OCCT import/export failed because the solid lives on the pane, or the pane did not answer. */
function paneJob(
  action: 'export' | 'import',
  error: string,
  fields: Record<string, unknown>,
): CadMcpResult {
  const needsPane = error === NEEDS_CAD_PANE || error.startsWith('Needs an open CAD pane')
  return fail(
    JSON.stringify(
      {
        needsPane,
        action,
        error,
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      },
      null,
      2,
    ),
  )
}

function exportName(name: string, format: string): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'part'
  if (format === 'json') return `${base}.cad.json`
  if (format === 'stp') return `${base}.step`
  if (format === 'igs') return `${base}.iges`
  return `${base}.${format}`
}

function documentForExport(doc: CadDocument, featureId?: string): CadDocument {
  if (!featureId) return doc
  const feature = doc.features.find((item) => item.id === featureId)
  if (!feature) return doc
  const sketches = feature.sketchId
    ? doc.sketches.filter((sketch) => sketch.id === feature.sketchId)
    : []
  return {
    ...doc,
    features: [feature],
    sketches,
    historyIndex: feature.suppressed ? 0 : 1,
  }
}

function parseJsonDocument(
  data: string,
  nested = false,
): { features: unknown[]; sketches: unknown[] } {
  const text = data.trim()
  const source = text.startsWith('{') || text.startsWith('[') ? text : decodeJsonText(text)
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch {
    throw new Error('Import data is not JSON')
  }
  if (Array.isArray(parsed)) return { features: parsed, sketches: [] }
  if (!parsed || typeof parsed !== 'object') throw new Error('JSON import must be an object')
  const root = parsed as Record<string, unknown>
  if (
    !nested &&
    !Array.isArray(root.features) &&
    !Array.isArray(root.sketches) &&
    typeof root.data === 'string'
  ) {
    return parseJsonDocument(root.data, true)
  }
  return {
    features: Array.isArray(root.features) ? root.features : [],
    sketches: Array.isArray(root.sketches) ? root.sketches : [],
  }
}

function decodeJsonText(data: string): string {
  const compact = data.replace(/\s/g, '')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(compact) || compact.length < 4) {
    throw new Error('Import data is not JSON')
  }
  const text = Buffer.from(compact, 'base64').toString('utf8').trim()
  if (!text.startsWith('{') && !text.startsWith('[')) throw new Error('Import data is not JSON')
  return text
}

function copySketch(raw: unknown, taken: Set<string>): CadSketch | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = raw as Args
  const sketch = buildSketch(record)
  if (typeof record.id === 'string' && FEATURE_ID.test(record.id) && !taken.has(record.id)) {
    sketch.id = record.id
  }
  taken.add(sketch.id)
  return sketch
}

function copyFeature(raw: unknown, taken: Set<string>): CadFeature | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const record = { ...(raw as Args) }
  if (typeof record.type !== 'string' && typeof record.kind === 'string') record.type = record.kind
  const feature = buildFeature(record)
  if (typeof record.id === 'string' && FEATURE_ID.test(record.id) && !taken.has(record.id)) {
    feature.id = record.id
  }
  if (typeof record.sketchId === 'string' && record.sketchId) feature.sketchId = record.sketchId
  taken.add(feature.id)
  return feature
}
