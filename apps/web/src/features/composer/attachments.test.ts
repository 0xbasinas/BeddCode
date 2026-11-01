import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/host.ts', () => ({ hostRequest: vi.fn(), upload: vi.fn() }))

import { hostRequest } from '../../stores/host.ts'
import {
  attachWorkspaceFile,
  attachmentDraftKey,
  stageAttachment,
  useAttachments,
  retryAttachment,
} from './attachments.ts'

const draft = attachmentDraftKey('remote', 'session')
beforeEach(() => {
  useAttachments.setState({ drafts: {} })
  vi.clearAllMocks()
})

describe('composer attachment drafts', () => {
  it('retries a failed upload in place and rejects retries after removal', async () => {
    const save = vi
      .fn()
      .mockRejectedValueOnce(new Error('Offline'))
      .mockResolvedValueOnce({ id: 'saved', size: 3 })
    expect(await stageAttachment('remote', 'session', 'retry.txt', 3, save)).toBe(false)
    const key = useAttachments.getState().drafts[draft]![0]!.key
    expect(await retryAttachment(draft, key)).toBe(true)
    expect(useAttachments.getState().drafts[draft]).toMatchObject([
      { key, id: 'saved', status: 'done' },
    ])
    useAttachments.getState().remove(draft, [key])
    expect(await retryAttachment(draft, key)).toBe(false)
    expect(save).toHaveBeenCalledTimes(2)
  })

  it('limits uploads per host and skips removed queued files', async () => {
    const finish: (() => void)[] = []
    const save = vi.fn(
      () =>
        new Promise<{ id: string; name: string; size: number }>((resolve) =>
          finish.push(() => resolve({ id: 'saved', name: 'file.txt', size: 1 })),
        ),
    )
    const jobs = Array.from({ length: 4 }, (_, n) =>
      stageAttachment('remote', 'session', `${n}.txt`, 1, save),
    )
    expect(save).toHaveBeenCalledTimes(3)
    const queued = useAttachments.getState().drafts[draft]![3]!
    expect(queued.status).toBe('queued')
    useAttachments.getState().remove(draft, [queued.key])
    // A saturated remote host does not block a different host.
    expect(
      await stageAttachment('local', 'session', 'local.txt', 1, async () => ({
        id: 'local',
        name: 'local',
        size: 1,
      })),
    ).toBe(true)
    finish.forEach((resolve) => resolve())
    expect(await Promise.all(jobs)).toEqual([true, true, true, false])
    expect(save).toHaveBeenCalledTimes(3)
  })
  it('keeps attachments separate by host and session, including late completions', async () => {
    let finish!: (value: { id: string; name: string; size: number }) => void
    const pending = stageAttachment(
      'remote',
      'session',
      'notes',
      3,
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    await stageAttachment('local', 'session', 'local', 1, async () => ({
      id: 'local-id',
      name: 'local',
      size: 1,
    }))
    await stageAttachment('remote', 'other', 'other', 1, async () => ({
      id: 'other-id',
      name: 'other',
      size: 1,
    }))
    expect(useAttachments.getState().drafts[draft]?.[0]?.status).toBe('uploading')
    finish({ id: 'remote-id', name: 'notes', size: 3 })
    await pending
    expect(useAttachments.getState().drafts[draft]).toMatchObject([
      { id: 'remote-id', status: 'done' },
    ])
    expect(useAttachments.getState().drafts[attachmentDraftKey('local', 'session')]).toMatchObject([
      { id: 'local-id' },
    ])
    expect(useAttachments.getState().drafts[attachmentDraftKey('remote', 'other')]).toMatchObject([
      { id: 'other-id' },
    ])
  })

  it('does not resurrect removed attachments or clear ones added during send', async () => {
    let finish!: (value: { id: string; name: string; size: number }) => void
    const pending = stageAttachment(
      'remote',
      'session',
      'old',
      1,
      () =>
        new Promise((r) => {
          finish = r
        }),
    )
    const sentKeys = useAttachments.getState().drafts[draft]!.map((a) => a.key)
    await stageAttachment('remote', 'session', 'new', 1, async () => ({
      id: 'new-id',
      name: 'new',
      size: 1,
    }))
    useAttachments.getState().remove(draft, sentKeys)
    finish({ id: 'old-id', name: 'old', size: 1 })
    await pending
    expect(useAttachments.getState().drafts[draft]).toMatchObject([{ id: 'new-id' }])
  })

  it('shows read failures and size limits without losing existing attachments', async () => {
    const save = vi.fn()
    expect(await stageAttachment('remote', 'session', 'large', 21 * 1024 * 1024, save)).toBe(false)
    expect(save).not.toHaveBeenCalled()
    expect(
      await stageAttachment('remote', 'session', 'missing', 0, async () => {
        throw new Error('File disappeared')
      }),
    ).toBe(false)
    expect(useAttachments.getState().drafts[draft]).toMatchObject([
      { status: 'error', error: 'Larger than 20 MB' },
      { status: 'error', error: 'File disappeared' },
    ])
  })

  it('snapshots a workspace file on the selected host without a client download', async () => {
    vi.mocked(hostRequest).mockResolvedValue({ id: 'image-id', name: 'image.png', size: 42 })
    await attachWorkspaceFile('remote', 'session', '/project', 'assets/image.png')
    expect(hostRequest).toHaveBeenCalledWith('remote', 'attachments.fromFile', {
      cwd: '/project',
      path: 'assets/image.png',
    })
    expect(useAttachments.getState().drafts[draft]).toMatchObject([
      { name: 'assets/image.png', id: 'image-id', size: 42 },
    ])
  })
})
