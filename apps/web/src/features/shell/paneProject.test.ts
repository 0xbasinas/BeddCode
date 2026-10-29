import { describe, expect, it } from 'vitest'
import { paneProject } from './paneProject.ts'

describe('paneProject', () => {
  it('names the project folder, on Windows and POSIX paths', () => {
    expect(paneProject({ cwd: '/home/me/api', projectPath: '/home/me/api' })).toEqual({
      label: 'api',
      title: '/home/me/api',
    })
    expect(paneProject({ cwd: 'C:\\code\\web\\', projectPath: 'C:\\code\\web\\' }).label).toBe(
      'web',
    )
  })

  it('marks a worktree, keeping the project name and the real folder', () => {
    expect(
      paneProject({ cwd: '/r/api/.wt/feat-x', projectPath: '/r/api', worktree: true }),
    ).toEqual({ label: 'api · worktree', title: '/r/api/.wt/feat-x' })
  })

  it('says when a session has no project', () => {
    expect(paneProject({ cwd: '/home/me/.beddcode/scratch/abc' }).label).toBe('No project')
  })
})
