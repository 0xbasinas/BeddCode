import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { lstatSync, readdirSync } from 'node:fs'
import path from 'node:path'

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024

export interface StoredAttachment {
  id: string
  name: string
  path: string
  size: number
}

/** Keeps only the file name and drops characters that are awkward in paths or shell lines. */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const cleaned = base
    .replace(/[^\w.\- ()]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return cleaned.slice(0, 120) || 'file'
}

/**
 * Files the user attaches to a prompt, stored on the host so any agent can read them by path.
 * Each upload gets its own directory, so identical names never collide.
 */
export class AttachmentStore {
  /** `root` is where uploads live; agents get read access to it so attachments never prompt. */
  constructor(readonly root: string) {}

  async save(name: string, data: Buffer): Promise<StoredAttachment> {
    if (data.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`Attachment is larger than ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB`)
    }
    const id = randomUUID()
    const fileName = safeFileName(name)
    const dir = path.join(this.root, id)
    await mkdir(dir, { recursive: true })
    const file = path.join(dir, fileName)
    await writeFile(file, data)
    const attachment = { id, name: fileName, path: file, size: data.length }
    return attachment
  }

  /**
   * The stored file an id or a path names, only if it lives under the store root. Paths are what a
   * sent message remembers, and they outlive the in-memory ids.
   */
  locate(ref: { id?: string; path?: string }): string | undefined {
    if (ref.id) return this.get(ref.id)?.path
    if (!ref.path) return undefined
    const file = path.resolve(ref.path)
    const rel = path.relative(path.resolve(this.root), file)
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? file : undefined
  }

  /** Resolve durable upload ids from their own directory after a host restart. */
  get(id: string): StoredAttachment | undefined {
    if (!/^[a-f0-9-]{36}$/i.test(id)) return undefined
    try {
      const dir = path.join(this.root, id)
      if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) return undefined
      const files = readdirSync(dir)
      if (files.length !== 1) return undefined
      const name = files[0]!
      const file = path.join(dir, name)
      const info = lstatSync(file)
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_ATTACHMENT_BYTES)
        return undefined
      return { id, name, path: file, size: info.size }
    } catch {
      return undefined
    }
  }

  /** Export only an actual upload, never an arbitrary workspace file. */
  async read(ref: { id?: string; path?: string }) {
    const id =
      ref.id ??
      (ref.path
        ? path.relative(path.resolve(this.root), path.resolve(ref.path)).split(path.sep)[0]
        : undefined)
    const stored = id ? this.get(id) : undefined
    if (!stored || (ref.path && path.resolve(ref.path) !== stored.path))
      throw new Error('Attachment is missing or is not a stored upload')
    const data = await readFile(stored.path)
    if (data.length > MAX_ATTACHMENT_BYTES) throw new Error('Attachment exceeds the export limit')
    return {
      id: stored.id,
      name: stored.name,
      size: data.length,
      dataBase64: data.toString('base64'),
    }
  }
}
