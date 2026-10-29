import type { PaneWorkspace } from '../../stores/composerWorkspace.ts'

const base = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path

/**
 * What the side tools say they are showing: the project folder's name, marked when the session
 * works in a worktree of it, and "No project" for a session without one. The hover title is the
 * actual folder.
 */
export function paneProject(workspace: Pick<PaneWorkspace, 'cwd' | 'projectPath' | 'worktree'>): {
  label: string
  title: string
} {
  const project = workspace.projectPath ? base(workspace.projectPath) : undefined
  if (!project)
    return { label: workspace.worktree ? base(workspace.cwd) : 'No project', title: workspace.cwd }
  return {
    label: workspace.worktree ? `${project} · worktree` : project,
    title: workspace.cwd,
  }
}
