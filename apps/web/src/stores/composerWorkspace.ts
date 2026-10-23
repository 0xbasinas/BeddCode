import { create } from 'zustand'

/** A pane needs a working folder and an attachment destination, not a running agent. */
export interface PaneWorkspace {
  cwd: string
  draftId: string
  title: string
  sessionId?: string
  instanceId?: string
  branch?: string
  status?: string
  worktree?: boolean
}

export const projectDraftId = (cwd: string) => JSON.stringify(['new-session', cwd])

/** Published by the new-session composer; session routes use their actual workspace instead. */
export const useComposerWorkspace = create<{
  workspace?: PaneWorkspace & { hostKey: string }
}>(() => ({}))
