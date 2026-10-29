import { readJsonFile, writeFileAtomic } from '@beddcode/shared'
import type { AgentPreview, SessionEvent } from '@beddcode/contracts'

const TTL_MS = 7 * 24 * 60 * 60_000

/** Bumped when what a preview holds changes, so answers kept by an older version are dropped. */
const VERSION = 2

interface Stored {
  v?: number
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
    const read = readJsonFile<Record<string, Stored>>(this.file)
    return read.status === 'ok' && read.value && typeof read.value === 'object' ? read.value : {}
  }

  private save() {
    if (!this.file) return
    try {
      writeFileAtomic(this.file, JSON.stringify(this.entries))
    } catch {
      // The cache is only a convenience; the next screen load probes again.
    }
  }

  get(instanceId: string): AgentPreview | undefined {
    const found = this.entries[instanceId]
    if (!found || found.v !== VERSION || this.now() - found.at > TTL_MS) return undefined
    return found.preview
  }

  /** How old the remembered answer is, in ms; undefined when there is none. */
  ageOf(instanceId: string): number | undefined {
    const found = this.entries[instanceId]
    return found ? this.now() - found.at : undefined
  }

  set(instanceId: string, preview: AgentPreview) {
    this.entries[instanceId] = { v: VERSION, at: this.now(), preview }
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

/**
 * Builds a preview from what a real ACP session reports about itself before its first turn, so the
 * new-session screen follows the agent (a new default model after an update, say) instead of a
 * probe from days ago. Only the first settings list counts: later ones already carry the choices
 * the user made for that session, not the agent's defaults. Each session is looked at once.
 */
export class PreviewSeeds {
  private readonly partial = new Map<string, Partial<AgentPreview>>()
  private readonly done = new Set<string>()

  /**
   * Returns the preview to remember when the session's first turn starts, else undefined.
   * `firstTurn` says whether this `turn.started` is the session's very first one; a resumed
   * session reports the settings it was left with, which are not the agent's defaults.
   */
  observe(
    sessionId: string,
    event: SessionEvent,
    firstTurn: () => boolean,
  ): AgentPreview | undefined {
    if (this.done.has(sessionId)) return undefined
    const partial = this.partial.get(sessionId) ?? {}
    switch (event.type) {
      case 'session.modes':
        partial.modes = event.modes
        partial.currentModeId = event.currentModeId
        break
      case 'session.config':
        partial.config ??= event.options
        break
      case 'session.commands':
        partial.commands = event.commands
        break
      case 'turn.started': {
        this.partial.delete(sessionId)
        this.done.add(sessionId)
        if (!firstTurn() || !partial.config) return undefined
        return {
          modes: partial.modes ?? [],
          currentModeId: partial.currentModeId,
          config: partial.config,
          commands: partial.commands ?? [],
        }
      }
      default:
        return undefined
    }
    this.partial.set(sessionId, partial)
    return undefined
  }

  forget(sessionId: string) {
    this.partial.delete(sessionId)
    this.done.delete(sessionId)
  }
}
