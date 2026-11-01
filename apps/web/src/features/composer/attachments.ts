import { create } from 'zustand'
import type { RpcResult } from '@beddcode/contracts'
import { hostRequest, upload } from '../../stores/host.ts'
import { UploadQueue } from './uploadQueue.ts'

export interface DraftAttachment {
  key: number
  name: string
  size: number
  status: 'queued' | 'uploading' | 'done' | 'error'
  id?: string
  error?: string
}

const MAX_BYTES = 20 * 1024 * 1024
export const EMPTY_ATTACHMENTS: DraftAttachment[] = []
export const attachmentDraftKey = (hostKey: string, draftId: string) =>
  JSON.stringify([hostKey, draftId])

const uploads = new UploadQueue()
const retries = new Map<number, () => Promise<boolean>>()

interface AttachmentState {
  drafts: Record<string, DraftAttachment[]>
  remove(draft: string, keys: number[]): void
}

export const useAttachments = create<AttachmentState>((set) => ({
  drafts: {},
  remove: (draft, keys) =>
    set((s) => {
      for (const key of keys) retries.delete(key)
      const drafts = { ...s.drafts }
      const remaining = (drafts[draft] ?? []).filter((f) => !keys.includes(f.key))
      if (remaining.length) drafts[draft] = remaining
      else delete drafts[draft]
      return { drafts }
    }),
}))

let nextKey = 1

/** Reserve a chip before starting work. A late upload never restores a removed attachment. */
export async function stageAttachment(
  hostKey: string,
  draftId: string,
  name: string,
  size: number,
  save: () => Promise<RpcResult<'attachments.upload'>>,
): Promise<boolean> {
  const draft = attachmentDraftKey(hostKey, draftId)
  const key = nextKey++
  useAttachments.setState((s) => ({
    drafts: {
      ...s.drafts,
      [draft]: [...(s.drafts[draft] ?? []), { key, name, size, status: 'queued' }],
    },
  }))
  const exists = () => useAttachments.getState().drafts[draft]?.some((f) => f.key === key) ?? false
  const patch = (change: Partial<DraftAttachment>) =>
    useAttachments.setState((s) => {
      if (!s.drafts[draft]?.some((f) => f.key === key)) return s
      return {
        drafts: {
          ...s.drafts,
          [draft]: s.drafts[draft]!.map((f) => (f.key === key ? { ...f, ...change } : f)),
        },
      }
    })
  const run = async () => {
    if (!exists()) return false
    patch({ status: 'queued', error: undefined })
    await uploads.add(
      hostKey,
      async () => {
        patch({ status: 'uploading' })
        try {
          if (size > MAX_BYTES) throw new Error('Larger than 20 MB')
          const saved = await save()
          patch({ status: 'done', id: saved.id, size: saved.size })
          retries.delete(key)
        } catch (err) {
          patch({ status: 'error', error: err instanceof Error ? err.message : 'Could not attach' })
        }
      },
      () => !exists(),
    )
    return (
      useAttachments.getState().drafts[draft]?.some((f) => f.key === key && f.status === 'done') ??
      false
    )
  }
  if (size <= MAX_BYTES) retries.set(key, run)
  return run()
}

/** Retries the original upload in place; completed and removed chips cannot be retried. */
export async function retryAttachment(draft: string, key: number): Promise<boolean> {
  if (!useAttachments.getState().drafts[draft]?.some((f) => f.key === key && f.status === 'error'))
    return false
  return retries.get(key)?.() ?? false
}

export const canRetryAttachment = (key: number) => retries.has(key)

export function attachUpload(hostKey: string, draftId: string, file: File) {
  return stageAttachment(hostKey, draftId, file.name || 'pasted-file', file.size, () =>
    upload(hostKey, file),
  )
}

/** Take a snapshot on the owning host. Binary files never pass through the editor's text API. */
export function attachWorkspaceFile(hostKey: string, sessionId: string, cwd: string, path: string) {
  return stageAttachment(hostKey, sessionId, path, 0, () =>
    hostRequest(hostKey, 'attachments.fromFile', { cwd, path }),
  )
}
