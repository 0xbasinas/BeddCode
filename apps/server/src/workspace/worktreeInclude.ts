// Adapted from Paseo's worktree-include plugin
// (https://github.com/getpaseo/paseo/blob/main/plugins/worktree-include/server/copy.ts),
// itself derived from cprecioso/paseo-worktreeinclude. MIT License,
// Copyright (c) 2026 Carlos Precioso. See THIRD_PARTY_NOTICES.md.
// Changes for BeddCode: timeouts on both git calls, never copies
// outside the worktree, refuses an oversized match, and reports failures per file instead of throwing.
import { spawn } from 'node:child_process'
import { constants, existsSync, lstatSync } from 'node:fs'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { runCommand } from '@beddcode/shared'

/** gitignore-style patterns, in the repository root, of ignored files a new worktree needs. */
export const WORKTREE_INCLUDE_FILE = '.worktreeinclude'
/**
 * More than this is almost certainly a pattern that matched build output or node_modules, not
 * local settings; nothing is copied then rather than half a tree.
 */
const MAX_FILES = 1000

export type WorktreeIncludeResult =
  | { kind: 'no-include-file' }
  | { kind: 'copied'; copied: string[]; skipped: string[]; failed: string[]; truncated: boolean }

const splitNul = (s: string) => s.split('\0').filter(Boolean)

/**
 * Copies files that match `.worktreeinclude` (gitignore syntax) AND are ignored by git from the
 * main checkout into a new worktree, so `.env` files and other local, untracked settings come
 * along. Tracked files are never touched, and a file that already exists in the worktree is kept.
 */
export async function copyWorktreeIncludes(
  worktree: string,
  source: string,
  git = 'git',
): Promise<WorktreeIncludeResult> {
  if (!existsSync(path.join(source, WORKTREE_INCLUDE_FILE))) return { kind: 'no-include-file' }

  const listed = await runCommand(
    git,
    ['ls-files', '--others', '--ignored', `--exclude-from=${WORKTREE_INCLUDE_FILE}`, '-z'],
    { cwd: source, timeoutMs: 30_000 },
  )
  if (listed.code !== 0) throw new Error(listed.stderr.trim() || 'git ls-files failed')
  const matches = splitNul(listed.stdout)
  if (matches.length === 0)
    return { kind: 'copied', copied: [], skipped: [], failed: [], truncated: false }

  // Only what git itself ignores: a pattern that also matches a tracked or merely untracked
  // file must not copy it over.
  const ignored = await checkIgnored(git, source, matches)
  const truncated = ignored.length > MAX_FILES
  if (truncated) return { kind: 'copied', copied: [], skipped: [], failed: [], truncated }
  const root = path.resolve(worktree)
  const copied: string[] = []
  const skipped: string[] = []
  const failed: string[] = []
  for (const file of ignored) {
    const from = path.join(source, file)
    const dest = path.resolve(root, file)
    if (dest !== root && !dest.startsWith(root + path.sep)) {
      failed.push(file)
      continue
    }
    if (existsSync(dest)) {
      skipped.push(file)
      continue
    }
    try {
      // Plain files only: a symlink could point anywhere on the machine.
      if (!lstatSync(from).isFile()) {
        skipped.push(file)
        continue
      }
      await mkdir(path.dirname(dest), { recursive: true })
      // Clone (copy-on-write) when the file system supports it, else a regular copy.
      await copyFile(from, dest, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL)
      copied.push(file)
    } catch {
      failed.push(file)
    }
  }
  return { kind: 'copied', copied, skipped, failed, truncated }
}

/** `git check-ignore --stdin -z`: which of these paths git ignores (exit 1 means none). */
function checkIgnored(git: string, cwd: string, files: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(git, ['check-ignore', '--stdin', '-z'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    const timer = setTimeout(() => child.kill(), 30_000)
    child.stdout.on('data', (d: Buffer) => out.push(d))
    child.stderr.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 || code === 1) resolve(splitNul(Buffer.concat(out).toString('utf8')))
      else
        reject(new Error(Buffer.concat(err).toString('utf8').trim() || 'git check-ignore failed'))
    })
    child.stdin.on('error', () => {})
    child.stdin.end(files.join('\0') + '\0')
  })
}
