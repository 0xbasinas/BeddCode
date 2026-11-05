import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '@beddcode/shared'

/** One solid operation in a document, in history order. */
export interface CadFeature {
  id: string
  type: string
  name: string
  params: Record<string, unknown>
  sketchId?: string
  suppressed?: boolean
}

/** A 2D profile on a plane. Features such as extrude refer to it by id. */
export interface CadSketch {
  id: string
  name: string
  plane: string
  entities: unknown[]
}

/**
 * A CAD model kept on a host. The pane and the agents' CAD tools share this JSON.
 * `historyIndex` is how many features are active; features after it are undone.
 */
export interface CadDocument {
  id: string
  name: string
  rev: number
  updatedAt: number
  units: 'mm'
  features: CadFeature[]
  sketches: CadSketch[]
  params: Record<string, unknown>
  historyIndex: number
}

export interface CadSummary {
  id: string
  name: string
  rev: number
  updatedAt: number
}

export interface CadChange {
  id: string
  rev: number
  origin?: string
  /** Ids of the features or sketches an agent just added or changed. */
  touched?: string[]
}

const SAFE_ID = /^[\w-]{1,64}$/

/** A fresh model: millimetres, nothing drawn. */
export const emptyDocument = (name: string): Omit<CadDocument, 'id' | 'rev' | 'updatedAt'> => ({
  name,
  units: 'mm',
  features: [],
  sketches: [],
  params: {},
  historyIndex: 0,
})

/**
 * The CAD documents of a host, one JSON file each. The pane and the agents' CAD tools both go
 * through here, so there is one copy of every model; each save bumps its `rev` and tells listeners.
 */
export class CadStore {
  private readonly cache = new Map<string, CadDocument>()
  private readonly listeners = new Set<(change: CadChange) => void>()

  constructor(private readonly dir: string) {}

  onChange(listener: (change: CadChange) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Not a CAD document id: ${id}`)
    return path.join(this.dir, `${id}.json`)
  }

  private load(id: string): CadDocument | undefined {
    const hit = this.cache.get(id)
    if (hit) return hit
    try {
      const raw = JSON.parse(readFileSync(this.file(id), 'utf8')) as Partial<CadDocument>
      if (typeof raw.id !== 'string' || !Array.isArray(raw.features)) return undefined
      const doc = this.normalize({
        id: raw.id,
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : 'Untitled',
        rev: typeof raw.rev === 'number' ? raw.rev : 1,
        updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
        units: 'mm',
        features: raw.features,
        sketches: Array.isArray(raw.sketches) ? raw.sketches : [],
        params:
          raw.params && typeof raw.params === 'object' && !Array.isArray(raw.params)
            ? (raw.params as Record<string, unknown>)
            : {},
        historyIndex: typeof raw.historyIndex === 'number' ? raw.historyIndex : raw.features.length,
      })
      this.cache.set(id, doc)
      return doc
    } catch {
      return undefined
    }
  }

  /** Keeps units in millimetres and the history cursor inside the feature list. */
  private normalize(doc: CadDocument): CadDocument {
    const features = Array.isArray(doc.features) ? doc.features : []
    const history = Number.isFinite(doc.historyIndex)
      ? Math.floor(doc.historyIndex)
      : features.length
    return {
      ...doc,
      units: 'mm',
      features,
      sketches: Array.isArray(doc.sketches) ? doc.sketches : [],
      params: doc.params && typeof doc.params === 'object' ? doc.params : {},
      historyIndex: Math.min(Math.max(history, 0), features.length),
    }
  }

  private write(doc: CadDocument): void {
    mkdirSync(this.dir, { recursive: true })
    const next = this.normalize(doc)
    writeFileAtomic(this.file(next.id), JSON.stringify(next))
    this.cache.set(next.id, next)
  }

  private summary(d: CadDocument): CadSummary {
    return { id: d.id, name: d.name, rev: d.rev, updatedAt: d.updatedAt }
  }

  list(): CadSummary[] {
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    return names
      .map((n) => this.load(n.slice(0, -5)))
      .filter((d): d is CadDocument => d !== undefined)
      .map((d) => this.summary(d))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): CadDocument | undefined {
    return this.load(id)
  }

  create(name?: string, origin?: string): CadDocument {
    const title = name?.trim() || 'Untitled'
    const doc: CadDocument = {
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      rev: 1,
      updatedAt: Date.now(),
      ...emptyDocument(title),
    }
    this.write(doc)
    this.emit(doc, origin)
    return doc
  }

  /** Replaces a document (the pane saves whole models). */
  save(id: string, doc: CadDocument, origin?: string, touched?: string[]): CadSummary {
    const current = this.load(id)
    if (!current) throw new Error(`No CAD document ${id}`)
    const name = typeof doc.name === 'string' && doc.name.trim() ? doc.name : current.name
    const next: CadDocument = {
      ...current,
      ...doc,
      id: current.id,
      name,
      units: 'mm',
      rev: current.rev + 1,
      updatedAt: Date.now(),
    }
    this.write(next)
    this.emit(next, origin, touched)
    return this.summary(next)
  }

  /** Changes a document in place with `edit`; used by the agents' tools. */
  mutate(
    id: string,
    edit: (doc: CadDocument) => void,
    origin?: string,
    touched?: string[],
  ): CadSummary {
    const current = this.load(id)
    if (!current) throw new Error(`No CAD document ${id}`)
    const doc = structuredClone(current)
    edit(doc)
    return this.save(id, doc, origin, touched)
  }

  remove(id: string): boolean {
    this.cache.delete(id)
    try {
      rmSync(this.file(id))
      return true
    } catch {
      return false
    }
  }

  private emit(doc: CadDocument, origin?: string, touched?: string[]) {
    for (const l of this.listeners)
      l({ id: doc.id, rev: doc.rev, origin, ...(touched?.length ? { touched } : {}) })
  }
}
