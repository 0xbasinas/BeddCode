import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Device } from '@beddcode/contracts'

interface StoredDevice {
  id: string
  name: string
  /** SHA-256 of the token. The token itself is shown once and never kept. */
  hash: string
  createdAt: number
  lastUsedAt?: number
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex')

/** Tokens of paired devices, in a small JSON file next to the database. */
export class TokenStore {
  private devices: StoredDevice[]
  private readonly revokeListeners = new Set<(deviceId: string) => void>()

  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {
    this.devices = this.load()
  }

  private load(): StoredDevice[] {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { devices?: StoredDevice[] }
      return Array.isArray(data.devices) ? data.devices : []
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`Could not read ${this.file}: ${err instanceof Error ? err.message : err}`)
    }
  }

  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, devices: this.devices }, null, 2), {
      mode: 0o600,
    })
    renameSync(tmp, this.file)
  }

  /** Creates a device and returns its token, the only time it is visible. */
  issue(name: string): { token: string; device: Device } {
    const token = randomBytes(32).toString('base64url')
    const stored: StoredDevice = {
      id: randomUUID(),
      name: name.trim().slice(0, 80) || 'Unnamed device',
      hash: sha256(token),
      createdAt: this.now(),
    }
    this.devices.push(stored)
    this.save()
    return { token, device: toDevice(stored) }
  }

  /** The device a token belongs to, or null. Comparison does not leak how much matched. */
  verify(token: string | undefined): Device | null {
    if (!token) return null
    const hash = Buffer.from(sha256(token), 'hex')
    for (const d of this.devices) {
      if (timingSafeEqual(hash, Buffer.from(d.hash, 'hex'))) {
        // Remember use at most once a minute so reads do not rewrite the file constantly.
        if (!d.lastUsedAt || this.now() - d.lastUsedAt > 60_000) {
          d.lastUsedAt = this.now()
          this.save()
        }
        return toDevice(d)
      }
    }
    return null
  }

  list(): Device[] {
    return this.devices.map(toDevice)
  }

  revoke(id: string): boolean {
    const before = this.devices.length
    this.devices = this.devices.filter((d) => d.id !== id)
    if (this.devices.length === before) return false
    this.save()
    for (const listener of this.revokeListeners) listener(id)
    return true
  }

  onRevoke(listener: (deviceId: string) => void): () => void {
    this.revokeListeners.add(listener)
    return () => {
      this.revokeListeners.delete(listener)
    }
  }
}

function toDevice(d: StoredDevice): Device {
  return { id: d.id, name: d.name, createdAt: d.createdAt, lastUsedAt: d.lastUsedAt }
}
