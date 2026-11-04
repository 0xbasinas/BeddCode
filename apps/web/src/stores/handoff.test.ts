import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionView } from '@beddcode/client-runtime'
import { clearHandoff, peekHandoff, prepareHandoff } from './handoff.ts'

const request = vi.hoisted(() => vi.fn())
vi.mock('./host.ts', () => ({ hostRequest: request }))

const session = {
  id: 'source',
  title: 'Task',
  cwd: '/repo/worktree',
  projectPath: '/repo',
  instanceId: 'claude',
  status: 'idle',
  items: [],
} as unknown as SessionView

describe('prepareHandoff', () => {
  beforeEach(() => {
    request.mockReset()
    clearHandoff()
  })

  it('includes the current diff and marks truncated patches', async () => {
    request.mockImplementation(async (_host, method) =>
      method === 'git.status'
        ? { files: [{ path: 'new.txt', status: 'A' }] }
        : { patch: '+new content', truncated: true },
    )
    await prepareHandoff('host', session, 'Claude')
    expect(request).toHaveBeenCalledWith('host', 'git.status', { cwd: '/repo/worktree' })
    expect(peekHandoff('host')).toMatchObject({
      source: { sessionId: 'source', cwd: '/repo/worktree' },
    })
    expect(peekHandoff('host')?.text).toContain('+new content')
    expect(peekHandoff('host')?.text).toContain('Diff unavailable or truncated')
    expect(peekHandoff('other')).toBeUndefined()
  })

  it('still prepares a reviewable packet when Git is unavailable', async () => {
    request.mockRejectedValue(new Error('not a repository'))
    await prepareHandoff('host', session)
    expect(peekHandoff('host')?.text).toContain('unavailable; inspect the working tree')
  })
})
