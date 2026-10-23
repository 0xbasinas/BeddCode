import type { RpcResult } from '@beddcode/contracts'
import { create } from 'zustand'

import { hostRequest } from './store'

export interface DraftAttachment {
  key: number
  name: string
  size: number
  status: 'uploading' | 'done' | 'error'
  id?: string
  error?: string
}

const MAX_BYTES = 20 * 1024 * 1024
export const EMPTY_ATTACHMENTS: DraftAttachment[] = []

interface AttachmentState {
  /** Attachments waiting to go out with the next message, by session. */
  drafts: Record<string, DraftAttachment[]>
  remove(draft: string, keys: number[]): void
}

export const useAttachments = create<AttachmentState>((set) => ({
  drafts: {},
  remove: (draft, keys) =>
    set((s) => {
      const drafts = { ...s.drafts }
      const remaining = (drafts[draft] ?? []).filter((f) => !keys.includes(f.key))
      if (remaining.length) drafts[draft] = remaining
      else delete drafts[draft]
      return { drafts }
    }),
}))

let nextKey = 1

/** Reserve a chip before starting work. A late upload never restores a removed attachment. */
async function stage(
  draft: string,
  name: string,
  size: number,
  save: () => Promise<RpcResult<'attachments.upload'>>,
): Promise<void> {
  const key = nextKey++
  useAttachments.setState((s) => ({
    drafts: {
      ...s.drafts,
      [draft]: [...(s.drafts[draft] ?? []), { key, name, size, status: 'uploading' }],
    },
  }))
  let patch: Partial<DraftAttachment>
  try {
    if (size > MAX_BYTES) throw new Error('Larger than 20 MB')
    const saved = await save()
    patch = { status: 'done', id: saved.id, size: saved.size }
  } catch (err) {
    patch = { status: 'error', error: err instanceof Error ? err.message : 'Could not attach' }
  }
  useAttachments.setState((s) => {
    if (!s.drafts[draft]?.some((f) => f.key === key)) return s
    return {
      drafts: {
        ...s.drafts,
        [draft]: s.drafts[draft]!.map((f) => (f.key === key ? { ...f, ...patch } : f)),
      },
    }
  })
}

/** UTF-8 text as base64, without Node's Buffer. */
export function textToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** Attach a piece of text (a selected terminal range, lines of a file, a picked page element). */
export function attachText(hostKey: string, sessionId: string, name: string, text: string) {
  return stage(sessionId, name, text.length, () =>
    hostRequest(hostKey, 'attachments.upload', { name, dataBase64: textToBase64(text) }),
  )
}

/** Attach bytes already encoded as base64 (a photo, a screenshot). */
export function attachBase64(
  hostKey: string,
  sessionId: string,
  name: string,
  dataBase64: string,
  size: number,
) {
  return stage(sessionId, name, size, () =>
    hostRequest(hostKey, 'attachments.upload', { name, dataBase64 }),
  )
}

/** Take a snapshot of a workspace file on its host; binary files never pass through the editor. */
export function attachWorkspaceFile(hostKey: string, sessionId: string, cwd: string, path: string) {
  return stage(sessionId, path, 0, () =>
    hostRequest(hostKey, 'attachments.fromFile', { cwd, path }),
  )
}
