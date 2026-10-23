import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/host.ts', () => ({ hostRequest: vi.fn(), upload: vi.fn() }))

import { hostRequest } from '../../stores/host.ts'
import {
  attachWorkspaceFile,
  attachmentDraftKey,
  stageAttachment,
  useAttachments,
} from './attachments.ts'

const draft = attachmentDraftKey('remote', 'session')
beforeEach(() => {
  useAttachments.setState({ drafts: {} })
  vi.clearAllMocks()
})

describe('composer attachment drafts', () => {
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
    await stageAttachment('remote', 'session', 'large', 21 * 1024 * 1024, save)
    expect(save).not.toHaveBeenCalled()
    await stageAttachment('remote', 'session', 'missing', 0, async () => {
      throw new Error('File disappeared')
    })
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
