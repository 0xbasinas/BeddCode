import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import type { Device } from '@beddcode/contracts'
import { createLogger, readJsonFile, writeFileAtomic } from '@beddcode/shared'

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
    const read = readJsonFile<{ devices?: StoredDevice[] }>(this.file)
    if (read.status === 'ok') {
      const devices = read.value?.devices
      return Array.isArray(devices)
        ? devices.filter((d) => d && typeof d.id === 'string' && typeof d.hash === 'string')
        : []
    }
    if (read.status === 'corrupt') {
      // Failing closed: no device is trusted until paired again, but the host still starts and
      // the damaged file is kept for the user to look at.
      createLogger('auth').error(
        `${this.file} is damaged (${read.error}); paired devices must pair again.` +
          (read.quarantined ? ` The old file was kept as ${read.quarantined}.` : ''),
      )
    }
    return []
  }

  private save() {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, devices: this.devices }, null, 2), {
      mode: 0o600,
    })
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
