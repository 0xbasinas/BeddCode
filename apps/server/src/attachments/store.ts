import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
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
  private readonly byId = new Map<string, StoredAttachment>()

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
    this.byId.set(id, attachment)
    return attachment
  }

  /** Resolves an id from `save`. Ids do not survive a server restart; re-attach after one. */
  get(id: string): StoredAttachment | undefined {
    return this.byId.get(id)
  }
}
