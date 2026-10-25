import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Design, DesignProject, DesignSummary } from '@beddcode/contracts'

export interface DesignChange {
  id: string
  rev: number
  origin?: string
}

const SAFE_ID = /^[\w-]{1,64}$/

/** A fresh canvas: one empty page. */
export const emptyProject = (name: string): DesignProject => ({
  name,
  pages: [{ id: 'page-1', name: 'Page 1', elements: [] }],
  activePageId: 'page-1',
})

/**
 * The design canvases of a host, one JSON file each. The editor in the app and the agents' design
 * tools both go through here, so there is one copy of every design; each save bumps its `rev`
 * and tells the listeners, which pass it on to connected clients.
 */
export class DesignStore {
  private readonly cache = new Map<string, Design>()
  private readonly listeners = new Set<(change: DesignChange) => void>()

  constructor(private readonly dir: string) {}

  onChange(listener: (change: DesignChange) => void): () => void {
    this.listeners.add(listener)
    return () => void this.listeners.delete(listener)
  }

  private file(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error(`Not a design id: ${id}`)
    return path.join(this.dir, `${id}.json`)
  }

  private load(id: string): Design | undefined {
    const hit = this.cache.get(id)
    if (hit) return hit
    try {
      const design = JSON.parse(readFileSync(this.file(id), 'utf8')) as Design
      if (typeof design.id !== 'string' || typeof design.project !== 'object') return undefined
      this.cache.set(id, design)
      return design
    } catch {
      return undefined
    }
  }

  private write(design: Design): void {
    mkdirSync(this.dir, { recursive: true })
    const file = this.file(design.id)
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(design))
    renameSync(tmp, file)
    this.cache.set(design.id, design)
  }

  private summary(d: Design): DesignSummary {
    return { id: d.id, name: d.name, rev: d.rev, updatedAt: d.updatedAt }
  }

  list(): DesignSummary[] {
    let names: string[] = []
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.json'))
    } catch {
      return []
    }
    return names
      .map((n) => this.load(n.slice(0, -5)))
      .filter((d): d is Design => d !== undefined)
      .map((d) => this.summary(d))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Design | undefined {
    return this.load(id)
  }

  create(name?: string, origin?: string): Design {
    const title = name?.trim() || 'Untitled'
    const design: Design = {
      id: randomUUID().replace(/-/g, '').slice(0, 12),
      name: title,
      rev: 1,
      updatedAt: Date.now(),
      project: emptyProject(title),
    }
    this.write(design)
    this.emit(design, origin)
    return design
  }

  /** Replaces a design's content (the editor saves whole projects). */
  save(id: string, project: DesignProject, origin?: string): DesignSummary {
    const design = this.load(id)
    if (!design) throw new Error(`No design ${id}`)
    const name = typeof project.name === 'string' && project.name.trim() ? project.name : design.name
    const next: Design = { ...design, name, project, rev: design.rev + 1, updatedAt: Date.now() }
    this.write(next)
    this.emit(next, origin)
    return this.summary(next)
  }

  /** Changes a design in place with `edit`; used by the agents' tools. */
  mutate(id: string, edit: (project: DesignProject) => void, origin?: string): DesignSummary {
    const design = this.load(id)
    if (!design) throw new Error(`No design ${id}`)
    const project = structuredClone(design.project)
    edit(project)
    return this.save(id, project, origin)
  }

  rename(id: string, name: string, origin?: string): DesignSummary {
    return this.mutate(id, (p) => void (p.name = name), origin)
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

  private emit(design: Design, origin?: string) {
    for (const l of this.listeners) l({ id: design.id, rev: design.rev, origin })
  }
}
