import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Base data directory. Override with BEDDCODE_HOME (tests, isolated instances). */
export function dataHome(): string {
  return process.env.BEDDCODE_HOME ?? path.join(os.homedir(), '.beddcode')
}

/** A host keeps its id across restarts and address changes. */
export function loadHostId(home: string): string {
  const file = path.join(home, 'host-id')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    // first run
  }
  const id = randomUUID()
  mkdirSync(home, { recursive: true })
  writeFileSync(file, id)
  return id
}
