import type { DraftAttachment } from './attachments.ts'

export const ATTACHMENT_DRAFT_STORAGE = 'beddcode.attachment-drafts.v1'

/** Only references are stored. An interrupted transfer needs its original file selected again. */
export function readAttachmentDrafts(raw: string | null): Record<string, DraftAttachment[]> {
  if (!raw) return {}
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    throw new Error('Invalid attachment drafts')
  const result: Record<string, DraftAttachment[]> = {}
  let key = 1
  for (const [draft, entries] of Object.entries(parsed).slice(0, 200)) {
    if (!Array.isArray(entries)) continue
    let scope: unknown
    try {
      scope = JSON.parse(draft)
    } catch {
      continue
    }
    if (!Array.isArray(scope) || scope.length !== 2 || !scope.every((s) => typeof s === 'string'))
      continue
    const list: DraftAttachment[] = []
    for (const value of entries.slice(0, 100)) {
      if (!value || typeof value !== 'object') continue
      const f = value as Partial<DraftAttachment>
      if (
        typeof f.name !== 'string' ||
        typeof f.size !== 'number' ||
        !Number.isFinite(f.size) ||
        f.size < 0
      )
        continue
      const id = typeof f.id === 'string' && f.id.length > 0 ? f.id.slice(0, 200) : undefined
      list.push({
        key: key++,
        name: f.name.slice(0, 500),
        size: f.size,
        ...(id ? { id } : {}),
        status: id ? 'checking' : 'error',
        error: id
          ? undefined
          : 'Upload interrupted. Remove this attachment and select the file again.',
      })
    }
    if (list.length) result[draft] = list
  }
  return result
}
