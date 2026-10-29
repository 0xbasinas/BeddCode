import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@beddcode/shared'
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
  // Written whole or not at all: a half-written id would make every paired device distrust this host.
  writeFileAtomic(file, id)
  return id
}

/**
 * The key this host shares with its paired devices for the relay: created once and kept, so a
 * restart does not cut off devices that already paired. Anyone holding it can reach this host
 * through the relay (a device still needs its own token), so it is only readable by this user.
 */
export function loadRelayKey(home: string, create: () => string): string {
  const file = path.join(home, 'relay-key')
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (existing) return existing
  } catch {
    // first run
  }
  const key = create()
  writeFileAtomic(file, key, { mode: 0o600 })
  return key
}
