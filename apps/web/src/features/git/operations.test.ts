import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../stores/host.ts', () => ({ hostRequest: vi.fn() }))

import { hostRequest } from '../../stores/host.ts'
import {
  commitFiles,
  dismissGitOperation,
  gitOperationKey,
  pushBranch,
  useGitOperations,
} from './operations.ts'

const key = gitOperationKey('local', '/project')
const params = { cwd: '/project', message: 'fix: retain push status', paths: ['a.txt'], push: true }
beforeEach(() => {
  useGitOperations.setState({ entries: {} })
  vi.clearAllMocks()
})

describe('Git operations across panes', () => {
  it('keeps an operation pending outside its originating tab and prevents duplicate requests', async () => {
    let finish!: (value: { hash: string; pushed: boolean }) => void
    vi.mocked(hostRequest).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        }),
    )
    const commit = commitFiles('local', params)
    expect(useGitOperations.getState().entries[key]).toMatchObject({
      revision: 0,
      operation: { kind: 'commit-and-push', pending: true },
    })
    dismissGitOperation('local', '/project')
    await expect(pushBranch('local', '/project')).rejects.toThrow('already running')
    expect(hostRequest).toHaveBeenCalledTimes(1)
    expect(hostRequest).toHaveBeenCalledWith('local', 'git.commit', params)
    finish({ hash: 'abc1234', pushed: true })
    await commit
    expect(useGitOperations.getState().entries[key]).toMatchObject({
      revision: 1,
      operation: { pending: false, hash: 'abc1234', pushed: true },
    })
  })

  it('retains a failed push and retries only the push, keeping the saved commit', async () => {
    vi.mocked(hostRequest).mockResolvedValueOnce({
      hash: 'saved123',
      pushed: false,
      pushError: 'permission denied',
    })
    await commitFiles('local', params)
    expect(useGitOperations.getState().entries[key]).toMatchObject({
      revision: 1,
      operation: {
        pending: false,
        hash: 'saved123',
        error: 'Commit saved. Push failed: permission denied',
      },
    })
    vi.mocked(hostRequest).mockResolvedValueOnce({})
    await pushBranch('local', '/project')
    expect(hostRequest).toHaveBeenLastCalledWith('local', 'git.push', { cwd: '/project' })
    expect(useGitOperations.getState().entries[key]).toMatchObject({
      revision: 2,
      operation: { kind: 'push', pending: false, hash: 'saved123', pushed: true },
    })
    expect(useGitOperations.getState().entries[key]?.operation?.error).toBeUndefined()
    expect(hostRequest).toHaveBeenCalledTimes(2)
  })

  it('never reports commit-and-push success without confirmation that the push completed', async () => {
    vi.mocked(hostRequest).mockResolvedValueOnce({ hash: 'saved123', pushed: false })
    await commitFiles('local', params)
    expect(useGitOperations.getState().entries[key]?.operation?.error).toContain(
      'did not confirm the push',
    )
  })

  it('keeps hosts and folders separate, records thrown errors, and dismisses only the chosen result', async () => {
    vi.mocked(hostRequest).mockResolvedValueOnce({ hash: 'remote123', pushed: true })
    await commitFiles('remote', params)
    vi.mocked(hostRequest).mockRejectedValueOnce(new Error('connection lost'))
    await expect(pushBranch('local', '/project')).rejects.toThrow('connection lost')
    expect(useGitOperations.getState().entries[key]).toMatchObject({
      revision: 1,
      operation: { pending: false, error: 'Push failed: connection lost' },
    })
    dismissGitOperation('local', '/project')
    expect(useGitOperations.getState().entries[key]).toEqual({ revision: 1 })
    expect(
      useGitOperations.getState().entries[gitOperationKey('remote', '/project')]?.operation?.hash,
    ).toBe('remote123')
    expect(useGitOperations.getState().entries[gitOperationKey('local', '/other')]).toBeUndefined()
  })
})
