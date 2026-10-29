import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs'
import path from 'node:path'

// A record of what agents did to the desktop, one JSON object per line. It holds what happened and
// to which program, never what was typed or what was on screen.

export interface AuditEntry {
  at: number
  sessionId: string
  tool: string
  app?: string
  /** The window's title, cut short. */
  window?: string
  outcome: 'ok' | 'error' | 'blocked' | 'declined' | 'stopped'
  ref?: string
  keys?: string
  /** How many characters were typed; never the text. */
  textLength?: number
  /** The start of the error or refusal. */
  detail?: string
}

const MAX_BYTES = 5 * 1024 * 1024

/** Appends entries to a file, keeping one older copy when it grows large. Never throws. */
export function auditFile(file: string): (entry: AuditEntry) => void {
  return (entry) => {
    try {
      mkdirSync(path.dirname(file), { recursive: true })
      try {
        if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`)
      } catch {
        // No file yet.
      }
      appendFileSync(file, `${JSON.stringify(entry)}\n`)
    } catch {
      // A log that cannot be written must not stop the agent's work or break a tool call.
    }
  }
}
