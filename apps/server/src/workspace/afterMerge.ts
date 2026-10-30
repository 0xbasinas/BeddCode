import { existsSync } from 'node:fs'
import type { PrCleanupResult } from '@beddcode/contracts'
import { GitError, type GitService } from './git.ts'
import type { GithubService } from './github.ts'

type Step = PrCleanupResult['steps'][number]

export interface AfterMergeDeps {
  git: GitService
  github: GithubService
  /** Stops the session's agent, then deletes its worktree (and its turn snapshots). */
  removeSessionWorktree(sessionId: string): Promise<boolean>
}

export interface AfterMergeRequest {
  cwd: string
  number: number
  sessionId?: string
  updateBase: boolean
  removeWorktree: boolean
  deleteBranch: boolean
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Tidies up after a merged pull request. Nothing is removed unless the merged pull request holds
 * everything the folder has: local commits it lacks and uncommitted files stop the steps that
 * would lose them, and say so.
 */
export async function cleanupAfterMerge(
  deps: AfterMergeDeps,
  request: AfterMergeRequest,
): Promise<PrCleanupResult> {
  const { git, github } = deps
  const { cwd } = request
  const info = await git.info(cwd)
  if (!info.isRepo) throw new GitError('This folder is not a git repository')
  const pr = await github.view(cwd, request.number)
  if (pr.state !== 'MERGED') throw new GitError('Only a merged pull request can be cleaned up')

  const mainRoot = info.mainRoot ?? info.root ?? cwd
  const onHeadBranch = info.branch === pr.headBranch
  const isWorktree = info.isWorktree === true
  const steps: Step[] = []

  // What this folder holds beyond the merged pull request, which removing it would lose.
  let unsafe: string | undefined
  if (!onHeadBranch) {
    unsafe = `This folder is on ${info.branch ?? 'a detached HEAD'}, not on ${pr.headBranch}`
  } else if (!pr.headOid || !(await git.headIsContainedIn(cwd, pr.headOid))) {
    unsafe = `${pr.headBranch} has local commits that the merged pull request does not`
  } else if (await git.isDirty(cwd)) {
    unsafe = 'The folder has uncommitted changes'
  }

  if (request.updateBase) {
    try {
      const moved = await git.fastForwardBase(mainRoot, pr.baseBranch)
      steps.push({ step: 'update-base', status: moved.status, detail: moved.detail })
    } catch (err) {
      steps.push({ step: 'update-base', status: 'failed', detail: message(err) })
    }
  }

  // A squash merge leaves the branch's own commits out of main, so keep them reachable: the
  // branch can be brought back from this ref after it is deleted.
  let backup: string | undefined
  if (request.deleteBranch && !unsafe) {
    try {
      backup = await git.backupHead(cwd, pr.headBranch)
    } catch (err) {
      unsafe = `Could not save a backup of ${pr.headBranch}: ${message(err)}`
    }
  }

  let worktreeGone = false
  if (request.removeWorktree) {
    if (!isWorktree) {
      steps.push({
        step: 'remove-worktree',
        status: 'skipped',
        detail: 'This folder is the main checkout, not a worktree',
      })
    } else if (unsafe) {
      steps.push({ step: 'remove-worktree', status: 'skipped', detail: unsafe })
    } else {
      try {
        worktreeGone = request.sessionId
          ? await deps.removeSessionWorktree(request.sessionId)
          : await git.removeWorktree(cwd)
        steps.push({
          step: 'remove-worktree',
          status: worktreeGone ? 'done' : 'skipped',
          detail: !worktreeGone
            ? 'The worktree was not found'
            : existsSync(cwd)
              ? `Removed from git, but some files are locked by a running program; delete ${cwd} when it stops`
              : undefined,
        })
      } catch (err) {
        steps.push({ step: 'remove-worktree', status: 'failed', detail: message(err) })
      }
    }
  }

  if (request.deleteBranch) {
    if (unsafe) {
      steps.push({ step: 'delete-branch', status: 'skipped', detail: unsafe })
    } else if (isWorktree && (await git.branchWorktree(mainRoot, pr.headBranch))) {
      // Asked of git, not assumed: a removal that failed late may still have unregistered it.
      steps.push({
        step: 'delete-branch',
        status: 'skipped',
        detail: 'The branch is still checked out in its worktree',
      })
    } else {
      try {
        // The main checkout cannot delete the branch it stands on; move it to the base first.
        if (!isWorktree) await git.switchTo(mainRoot, pr.baseBranch)
        await git.deleteBranch(mainRoot, pr.headBranch)
        steps.push({
          step: 'delete-branch',
          status: 'done',
          detail: backup ? `${pr.headBranch} (a copy is kept at ${backup})` : pr.headBranch,
        })
      } catch (err) {
        steps.push({ step: 'delete-branch', status: 'failed', detail: message(err) })
      }
    }
  }
  return { steps }
}
