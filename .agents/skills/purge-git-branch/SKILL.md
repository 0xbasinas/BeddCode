---
name: purge-git-branch
description: Fully remove a git branch from GitHub and the local clone, including a branch that is already gone from the remote but still seems to linger. Use this whenever the user asks to delete, wipe, purge, or clean up a branch, pastes `git push origin --delete`, shares a github.com/.../tree/<branch> link to remove, or wants to "reset" a stale branch name by recreating and deleting it, even if they don't say "skill".
---

# Purge a git branch

Remove a branch from origin and locally, without losing unmerged work.

## 1. Resolve the branch

Take the name from the user's message. In a GitHub URL it is everything after `/tree/` and may contain slashes. Refuse to delete the default branch; find it with `gh repo view --json defaultBranchRef`. Below, `<default>` means that branch.

## 2. Inspect before deleting

Remote deletion is hard to undo, so look first:

```bash
git fetch origin <default>
git ls-remote origin refs/heads/<branch>
git branch --list <branch>
git worktree list
gh pr list --head <branch> --state all --json number,state,title,url
```

If the branch exists on the remote, fetch it and list the commits that would be lost:

```bash
git fetch origin "+refs/heads/<branch>:refs/remotes/origin/<branch>"
git log --oneline origin/<default>..origin/<branch>
```

A squash or rebase merge leaves commits listed here even though the work landed, so a merged PR is the better signal. Stop and show the user what you found before going on if any of these hold:

- There are commits and no merged PR for the branch.
- A PR for the branch is open. Deleting its head closes it.
- The branch is checked out in another worktree. Git refuses to delete it there, and that worktree may hold uncommitted work.

Skip the stop if the user has already seen these facts and said to go ahead.

## 3. Delete

**Branch exists on the remote:**

```bash
git checkout <default>
git push origin --delete <branch>
git branch -d <branch>
```

Skip the last command if there is no local branch. If `-d` fails on a squash-merged branch, use `-D` only after step 2 showed a merged PR or the user accepted losing the commits.

**Branch is already gone from the remote:** tell the user there is nothing to delete, and only delete any local copy and stale tracking ref (`git fetch origin --prune`). Recreate it only if the user explicitly wants the recreate-and-delete reset:

```bash
git checkout <default>
git checkout -b <branch>
git push origin <branch>
git checkout <default>
git push origin --delete <branch>
git branch -d <branch>
```

This creates a copy of `<default>`, so it is safe, but pushing can trigger CI or webhooks. Check the working tree is clean first, and if a local branch of that name already exists, inspect it before doing anything to it. Chain the commands with `&&` so a failure stops the sequence.

## 4. Verify and report

```bash
git ls-remote origin refs/heads/<branch>
git branch --list <branch>
git status -sb
```

The first two should print nothing, and the user should be on `<default>`. Report what was deleted and where, and anything skipped.

Be straight about the limits: merged and closed PRs keep their reference to the branch name permanently. The recreate-and-delete reset doesn't remove that, so if GitHub still mentions the name, a PR is the likely source.
