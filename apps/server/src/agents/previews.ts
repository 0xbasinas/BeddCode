import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { AgentPreview } from '@beddcode/contracts'

const TTL_MS = 7 * 24 * 60 * 60_000

interface Stored {
  at: number
  preview: AgentPreview
}

/**
 * What an agent offers for a new session (its modes, model and effort settings, commands), kept so
 * the new-session screen can show them at once. ACP agents only say this when a session starts, so
 * the answer comes from a probe the first time and is remembered after that.
 */
export class PreviewCache {
  private entries: Record<string, Stored>

  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {
    this.entries = this.load()
  }

  private load(): Record<string, Stored> {
    if (!this.file) return {}
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, Stored>
      return data && typeof data === 'object' ? data : {}
    } catch {
      return {}
    }
  }

  private save() {
    if (!this.file) return
    try {
      mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      writeFileSync(tmp, JSON.stringify(this.entries))
      renameSync(tmp, this.file)
    } catch {
      // The cache is only a convenience; the next screen load probes again.
    }
  }

  get(instanceId: string): AgentPreview | undefined {
    const found = this.entries[instanceId]
    if (!found || this.now() - found.at > TTL_MS) return undefined
    return found.preview
  }

  set(instanceId: string, preview: AgentPreview) {
    this.entries[instanceId] = { at: this.now(), preview }
    this.save()
  }

  clearAll() {
    this.entries = {}
    this.save()
  }

  /** Forget an agent whose command or settings may have changed. */
  clear(instanceId: string) {
    if (!(instanceId in this.entries)) return
    delete this.entries[instanceId]
    this.save()
  }
}
