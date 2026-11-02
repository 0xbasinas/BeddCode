import type { SessionView } from '@beddcode/client-runtime'
import { exportSession } from './exportSession.ts'

const encoder = new TextEncoder()
const MAX_BYTES = 30 * 1024 * 1024

/** A plain USTAR archive, supported by standard archive readers without a new runtime dependency. */
export function tarFiles(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const parts: Uint8Array[] = []
  for (const file of files) {
    if (file.name.length > 99 || file.name.includes('..') || file.name.startsWith('/'))
      throw new Error('Invalid archive entry name')
    const header = new Uint8Array(512)
    const put = (at: number, value: string) => header.set(encoder.encode(value), at)
    const octal = (n: number, length: number) => n.toString(8).padStart(length - 1, '0') + '\0'
    put(0, file.name)
    put(100, '0000644\0')
    put(108, '0000000\0')
    put(116, '0000000\0')
    put(124, octal(file.data.length, 12))
    put(136, octal(0, 12))
    put(148, '        ')
    put(156, '0')
    put(257, 'ustar\0')
    put(263, '00')
    const sum = header.reduce((n, b) => n + b, 0)
    put(148, sum.toString(8).padStart(6, '0') + '\0 ')
    parts.push(header, file.data, new Uint8Array((512 - (file.data.length % 512)) % 512))
  }
  parts.push(new Uint8Array(1024))
  const result = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

export async function sessionArchive(
  session: Pick<SessionView, 'id' | 'title' | 'status' | 'items'>,
  host: string,
  read: (path: string) => Promise<{ dataBase64: string; size: number }>,
) {
  const files = [{ name: 'transcript.md', data: encoder.encode(exportSession(session, host)) }]
  let bytes = 0
  const assets: { name: string; entry?: string; included: boolean; reason?: string }[] = []
  const attachments = session.items.flatMap((item) =>
    item.kind === 'message' ? (item.attachments ?? []) : [],
  )
  const seen = new Set<string>()
  for (const attachment of attachments) {
    if (seen.has(attachment.path)) continue
    seen.add(attachment.path)
    if (seen.size > 100 || bytes >= MAX_BYTES) {
      assets.push({
        name: attachment.name,
        included: false,
        reason: 'Archive attachment limit reached',
      })
      continue
    }
    try {
      const saved = await read(attachment.path)
      if (saved.size > MAX_BYTES - bytes) throw new Error('Archive attachment size limit reached')
      const binary = atob(saved.dataBase64)
      const data = Uint8Array.from(binary, (char) => char.charCodeAt(0))
      if (data.length !== saved.size) throw new Error('Attachment size did not match')
      const safe =
        attachment.name
          .split(/[\\/]/)
          .at(-1)!
          .replace(/[^a-zA-Z0-9._-]/g, '_')
          .replace(/\.{2,}/g, '_')
          .slice(0, 65) || 'file'
      const name = `attachments/${String(assets.length + 1).padStart(3, '0')}-${safe}`
      files.push({ name, data })
      bytes += data.length
      assets.push({ name: attachment.name, entry: name, included: true })
    } catch (err) {
      assets.push({
        name: attachment.name,
        included: false,
        reason: err instanceof Error ? err.message : 'Unavailable',
      })
    }
  }
  files.push({
    name: 'manifest.json',
    data: encoder.encode(
      JSON.stringify(
        {
          format: 'beddcode-session-archive',
          version: 1,
          sessionId: session.id,
          host,
          exportedAt: new Date().toISOString(),
          coverage:
            'Loaded transcript only; not resumable. Attachment inclusion is described below.',
          attachments: assets,
        },
        null,
        2,
      ),
    ),
  })
  return tarFiles(files)
}
