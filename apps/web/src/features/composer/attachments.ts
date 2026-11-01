import { create } from 'zustand'
import type { RpcResult } from '@beddcode/contracts'
import { hostRequest, upload } from '../../stores/host.ts'
import { UploadQueue } from './uploadQueue.ts'
import { ATTACHMENT_DRAFT_STORAGE, readAttachmentDrafts } from './attachmentPersistence.ts'

export interface DraftAttachment {
  key: number
  name: string
  size: number
  status: 'checking' | 'queued' | 'uploading' | 'done' | 'error'
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
  storageError?: string
  drafts: Record<string, DraftAttachment[]>
  remove(draft: string, keys: number[]): void
}

function loadDrafts(): Pick<AttachmentState, 'drafts' | 'storageError'> {
  try {
    return {
      drafts: readAttachmentDrafts(
        globalThis.localStorage?.getItem(ATTACHMENT_DRAFT_STORAGE) ?? null,
      ),
    }
  } catch {
    return {
      drafts: {},
      storageError: 'Attachment drafts could not be restored from this browser.',
    }
  }
}

export const useAttachments = create<AttachmentState>((set) => ({
  ...loadDrafts(),
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

useAttachments.subscribe((state, before) => {
  if (state.drafts === before.drafts) return
  try {
    globalThis.localStorage?.setItem(ATTACHMENT_DRAFT_STORAGE, JSON.stringify(state.drafts))
    if (state.storageError) useAttachments.setState({ storageError: undefined })
  } catch {
    useAttachments.setState({
      storageError: 'Attachment drafts could not be saved in this browser.',
    })
  }
})

let nextKey =
  Math.max(
    0,
    ...Object.values(useAttachments.getState().drafts)
      .flat()
      .map((f) => f.key),
  ) + 1

/** Revalidate restored references on the owning host before they can be sent. */
export async function validateAttachmentDraft(hostKey: string, draftId: string): Promise<void> {
  const draft = attachmentDraftKey(hostKey, draftId)
  const files = (useAttachments.getState().drafts[draft] ?? []).filter(
    (f) => f.status === 'checking' && f.id,
  )
  if (!files.length) return
  try {
    const found = await hostRequest(hostKey, 'attachments.inspect', {
      ids: files.map((f) => f.id!),
    })
    useAttachments.setState((s) => ({
      drafts: {
        ...s.drafts,
        [draft]: (s.drafts[draft] ?? []).map((f) => {
          const at = files.findIndex((old) => old.key === f.key)
          if (at < 0 || f.status !== 'checking') return f
          const file = found[at]
          return file
            ? { ...f, name: file.name, size: file.size, status: 'done' as const, error: undefined }
            : {
                ...f,
                status: 'error' as const,
                error: 'File is missing on the host. Remove it and attach it again.',
              }
        }),
      },
    }))
  } catch (err) {
    useAttachments.setState({
      storageError: `Could not verify saved attachments: ${err instanceof Error ? err.message : String(err)}. Reconnect to retry.`,
    })
  }
}

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
