import { randomBytes } from 'node:crypto'
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import type {
  GitBranch,
  GitCommit,
  GitDiff,
  GitFile,
  GitInfo,
  GitLog,
  GitStatus,
} from '@beddcode/contracts'
import { diffText, runCommand, type RunResult } from '@beddcode/shared'

export type Runner = (
  file: string,
  args: string[],
  options: { cwd: string; timeoutMs?: number; env?: Record<string, string> },
) => Promise<RunResult>

/** The hash every repository knows: used as "before" when a branch has no commits yet. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const MAX_FILE_BYTES = 1024 * 1024
const MAX_PATCH_LINES = 600

const defaultRunner: Runner = (file, args, { cwd, timeoutMs, env }) =>
  runCommand(file, args, {
    cwd,
    timeoutMs: timeoutMs ?? 30_000,
    // Never block on a credential prompt; stable English output for parsing.
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      LC_ALL: 'C',
      GIT_OPTIONAL_LOCKS: '0',
      ...env,
    },
  })

/** Who snapshot commits are by, so they never depend on (or borrow) the user's identity. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'BeddCode',
  GIT_AUTHOR_EMAIL: 'checkpoints@beddcode.local',
  GIT_COMMITTER_NAME: 'BeddCode',
  GIT_COMMITTER_EMAIL: 'checkpoints@beddcode.local',
}
/**
 * Snapshots keep and put back a file's exact bytes: with Git for Windows' default
 * `core.autocrlf=true`, adding would turn CRLF into LF and restoring would write CRLF over a file
 * that had LF, so an undo would not give back what the turn started from.
 */
const SNAPSHOT_BYTES = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false']
const MAX_TURN_FILES = 200

/** One file that differs between two snapshots. */
export interface SnapshotChange {
  path: string
  status: 'A' | 'M' | 'D' | 'R'
  oldPath?: string
  added: number
  removed: number
  binary?: boolean
}

export class GitError extends Error {}

const toPosix = (p: string) => p.replace(/\\/g, '/')

/** Everything the app needs from git, by shelling out to the user's own `git`. */
export class GitService {
  private readonly writes = new Map<string, Promise<unknown>>()
  constructor(private readonly run: Runner = defaultRunner) {}

  private async write<T>(root: string, action: () => Promise<T>): Promise<T> {
    const previous = this.writes.get(root) ?? Promise.resolve()
    const pending = previous.catch(() => {}).then(action)
    this.writes.set(root, pending)
    try {
      return await pending
    } finally {
      if (this.writes.get(root) === pending) this.writes.delete(root)
    }
  }

  private async git(cwd: string, args: string[], timeoutMs?: number): Promise<string> {
    const res = await this.gitRaw(cwd, args, timeoutMs)
    if (res.code !== 0) {
      throw new GitError(res.stderr.trim() || res.stdout.trim() || `git ${args[0]} failed`)
    }
    return res.stdout
  }

  private gitRaw(
    cwd: string,
    args: string[],
    timeoutMs?: number,
    env?: Record<string, string>,
  ): Promise<RunResult> {
    return this.run('git', ['--literal-pathspecs', '-c', 'core.quotepath=false', ...args], {
      cwd,
      timeoutMs,
      env,
    }).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') throw new GitError('Git is not installed on this host')
      throw err
    })
  }

  /** Turns a plain folder into a repository (`git init`, with the user's own defaults). */
  async init(cwd: string): Promise<void> {
    if (!isDirectory(cwd)) throw new GitError(`Folder does not exist: ${cwd}`)
    await this.git(cwd, ['init', '-q'])
  }

  async info(cwd: string): Promise<GitInfo> {
    if (!isDirectory(cwd)) throw new GitError(`Folder does not exist: ${cwd}`)
    const inside = await this.gitRaw(cwd, ['rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { isRepo: false }

    const root = path.resolve((await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim())
    const common = path.resolve(
      (await this.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim(),
    )
    const mainRoot = path.basename(common) === '.git' ? path.dirname(common) : root

    const head = (await this.gitRaw(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])).stdout.trim()
    const upstreamRes = await this.gitRaw(cwd, [
      'rev-parse',
      '--abbrev-ref',
      '--symbolic-full-name',
      '@{u}',
    ])
    const upstream = upstreamRes.code === 0 ? upstreamRes.stdout.trim() : undefined

    let ahead: number | undefined
    let behind: number | undefined
    if (upstream) {
      const counts = await this.gitRaw(cwd, ['rev-list', '--left-right', '--count', '@{u}...HEAD'])
      const [b, a] = counts.stdout.trim().split(/\s+/).map(Number)
      if (counts.code === 0) [behind, ahead] = [b, a]
    }

    return {
      isRepo: true,
      root,
      mainRoot,
      isWorktree: path.resolve(root) !== path.resolve(mainRoot),
      branch: head || undefined,
      detached: head ? undefined : true,
      upstream,
      ahead,
      behind,
      defaultBranch: await this.defaultBranch(cwd, head || undefined),
    }
  }

  private async defaultBranch(
    cwd: string,
    current: string | undefined,
  ): Promise<string | undefined> {
    const origin = await this.gitRaw(cwd, [
      'symbolic-ref',
      '--short',
      '-q',
      'refs/remotes/origin/HEAD',
    ])
    if (origin.code === 0 && origin.stdout.trim())
      return origin.stdout.trim().replace(/^origin\//, '')
    for (const name of ['main', 'master']) {
      const ok = await this.gitRaw(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
      if (ok.code === 0) return name
    }
    return current
  }

  /** Root of the repository, or an error when `cwd` is not inside one. */
  private async root(cwd: string): Promise<string> {
    if (!isDirectory(cwd)) throw new GitError(`Folder does not exist: ${cwd}`)
    const root = await this.gitRaw(cwd, ['rev-parse', '--show-toplevel'])
    if (root.code !== 0 || !root.stdout.trim())
      throw new GitError('This folder is not a git repository')
    return path.resolve(root.stdout.trim())
  }

  private async baseline(cwd: string): Promise<string> {
    const head = await this.gitRaw(cwd, ['rev-parse', '--verify', '-q', 'HEAD'])
    return head.code === 0 ? 'HEAD' : EMPTY_TREE
  }

  async status(cwd: string): Promise<GitStatus> {
    const root = await this.root(cwd)
    const [info, porcelain, stats] = await Promise.all([
      this.info(root),
      this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
      this.baseline(root).then((base) => this.git(root, ['diff', base, '--numstat', '-z'])),
    ])
    const numstat = parseNumstat(stats)

    const files: GitFile[] = []
    const entries = porcelain.split('\0')
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (!entry || entry.length < 4) continue
      const x = entry[0]!
      const y = entry[1]!
      const file = entry.slice(3)
      // A rename lists its old path as the next entry; it is not a file of its own.
      const oldPath = x === 'R' || x === 'C' ? entries[++i] : undefined

      const untracked = x === '?'
      const letter = untracked ? 'A' : x !== ' ' ? x : y
      const status =
        letter === 'D' ? 'D' : letter === 'A' ? 'A' : letter === 'R' || letter === 'C' ? 'R' : 'M'
      const counts = untracked
        ? countLines(path.join(root, file))
        : (numstat.get(file) ?? { added: 0, removed: 0 })
      files.push({
        path: toPosix(file),
        status,
        staged: !untracked && x !== ' ',
        ...(oldPath ? { oldPath: toPosix(oldPath) } : {}),
        added: counts.added,
        removed: counts.removed,
      })
    }
    files.sort((a, b) => a.path.localeCompare(b.path))
    return { branch: info.branch, ahead: info.ahead ?? 0, behind: info.behind ?? 0, files }
  }

  async diff(cwd: string, file: string): Promise<GitDiff> {
    const root = await this.root(cwd)
    assertRelative(file)
    return this.diffAtRoot(root, file)
  }

  private async diffAtRoot(
    root: string,
    file: string,
    known?: { baseline: string; tracked: boolean },
  ): Promise<GitDiff> {
    const abs = path.join(root, file)

    const tracked =
      known?.tracked ??
      (await this.gitRaw(root, ['ls-files', '--error-unmatch', '--', file])).code === 0
    if (!tracked && existsSync(abs)) {
      // Untracked: the whole file is new.
      const text = readText(abs)
      if (text === null) return { path: file, patch: '', added: 0, removed: 0, truncated: true }
      const d = diffText(null, text)
      return { path: file, ...d, truncated: false }
    }

    const out = await this.git(root, [
      'diff',
      known?.baseline ?? (await this.baseline(root)),
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=3',
      '--',
      file,
    ])
    return patchOf(file, out)
  }

  /**
   * Records the folder's current files (tracked and untracked, minus ignored ones) as a commit
   * under `ref`, without touching the index, HEAD or any branch: git's own index is copied to a
   * scratch file so staging stays exactly as the user left it. Returns the snapshot commit.
   */
  async snapshot(
    cwd: string,
    ref?: string,
    { timeoutMs = 15_000, maxUntracked }: { timeoutMs?: number; maxUntracked?: number } = {},
  ): Promise<string> {
    const root = await this.root(cwd)
    if (maxUntracked !== undefined) {
      // Thousands of files that are neither tracked nor ignored (an unignored node_modules) would
      // be copied into the repository's objects on every turn: skip instead.
      const others = await this.gitRaw(
        root,
        ['ls-files', '--others', '--exclude-standard', '-z'],
        timeoutMs,
      )
      if (others.stdout.split('\0').length - 1 > maxUntracked) {
        throw new GitError('Too many untracked files to snapshot')
      }
    }
    const indexPath = (
      await this.git(root, ['rev-parse', '--path-format=absolute', '--git-path', 'index'])
    ).trim()
    const scratch = `${indexPath}.beddcode-${randomBytes(4).toString('hex')}`
    try {
      if (existsSync(indexPath)) copyFileSync(indexPath, scratch)
      const env = { GIT_INDEX_FILE: scratch }
      const add = await this.gitRaw(
        root,
        [...SNAPSHOT_BYTES, 'add', '-A', '--', '.'],
        timeoutMs,
        env,
      )
      if (add.code !== 0) throw new GitError(add.stderr.trim() || 'Could not snapshot the folder')
      const tree = (await this.gitRaw(root, ['write-tree'], timeoutMs, env)).stdout.trim()
      if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new GitError('Could not snapshot the folder')
      const commit = await this.gitRaw(
        root,
        ['commit-tree', '--no-gpg-sign', tree, '-m', 'BeddCode checkpoint'],
        timeoutMs,
        SNAPSHOT_IDENTITY,
      )
      const hash = commit.stdout.trim()
      if (commit.code !== 0 || !/^[0-9a-f]{40,64}$/.test(hash)) {
        throw new GitError(commit.stderr.trim() || 'Could not snapshot the folder')
      }
      // A ref keeps the snapshot from being garbage-collected.
      if (ref) await this.git(root, ['update-ref', ref, hash])
      return hash
    } finally {
      rmSync(scratch, { force: true })
    }
  }

  /** Files that differ between two snapshots, with line counts. */
  async snapshotChanges(
    cwd: string,
    from: string,
    to: string,
  ): Promise<{ files: SnapshotChange[]; truncated: boolean }> {
    assertHash(from)
    assertHash(to)
    const root = await this.root(cwd)
    const nameStatus = await this.git(root, ['diff', '--name-status', '-z', '-M', from, to])
    const numstat = await this.git(root, ['diff', '--numstat', '-z', '-M', from, to])
    const counts = parseNumstat(numstat)
    const binary = new Set(
      numstat
        .split('\0')
        .filter((entry) => entry.startsWith('-\t-\t') && entry.length > 4)
        .map((entry) => toPosix(entry.slice(4))),
    )
    const parts = nameStatus.split('\0')
    const files: SnapshotChange[] = []
    for (let i = 0; i < parts.length - 1;) {
      const code = parts[i++]!
      const kind = code[0]
      let oldPath: string | undefined
      let file = parts[i++]!
      if (kind === 'R' || kind === 'C') {
        oldPath = file
        file = parts[i++]!
      }
      if (!file) continue
      const count = counts.get(toPosix(file)) ?? { added: 0, removed: 0 }
      files.push({
        path: toPosix(file),
        status: kind === 'A' || kind === 'C' ? 'A' : kind === 'D' ? 'D' : kind === 'R' ? 'R' : 'M',
        ...(kind === 'R' && oldPath ? { oldPath } : {}),
        added: count.added,
        removed: count.removed,
        ...(binary.has(toPosix(file)) ? { binary: true } : {}),
      })
    }
    return { files: files.slice(0, MAX_TURN_FILES), truncated: files.length > MAX_TURN_FILES }
  }

  /** One file's diff between two snapshots. */
  async snapshotDiff(cwd: string, from: string, to: string, file: string): Promise<GitDiff> {
    assertHash(from)
    assertHash(to)
    assertRelative(file)
    const root = await this.root(cwd)
    const out = await this.git(root, [
      'diff',
      from,
      to,
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--unified=3',
      '--',
      file,
    ])
    return patchOf(file, out)
  }

  /** Whether the folder's files are exactly what snapshot `hash` recorded. */
  async matchesSnapshot(cwd: string, hash: string): Promise<boolean> {
    assertHash(hash)
    const now = await this.snapshot(cwd)
    const root = await this.root(cwd)
    const [a, b] = await Promise.all([
      this.git(root, ['rev-parse', `${now}^{tree}`]),
      this.git(root, ['rev-parse', `${hash}^{tree}`]),
    ])
    return a.trim() === b.trim()
  }

  /**
   * Puts every file that differs between `from` and `to` back the way `from` had it: changed and
   * deleted files are restored, files that only `to` has are removed. Staged changes and commits
   * are left alone. Returns how many files were touched.
   */
  async restoreSnapshot(cwd: string, from: string, to: string): Promise<number> {
    assertHash(from)
    assertHash(to)
    const root = await this.root(cwd)
    return this.write(root, async () => {
      const out = await this.git(root, ['diff', '--name-status', '-z', '--no-renames', from, to])
      const parts = out.split('\0')
      const restore: string[] = []
      const remove: string[] = []
      for (let i = 0; i < parts.length - 1; i += 2) {
        const kind = parts[i]![0]
        const file = parts[i + 1]!
        if (!file) continue
        assertRelative(file)
        if (kind === 'A') remove.push(file)
        else restore.push(file)
      }
      for (const file of remove) rmSync(path.join(root, file), { force: true })
      for (let i = 0; i < restore.length; i += 100) {
        await this.git(root, [
          ...SNAPSHOT_BYTES,
          'restore',
          `--source=${from}`,
          '--worktree',
          '--',
          ...restore.slice(i, i + 100),
        ])
      }
      return restore.length + remove.length
    })
  }

  /** Drops snapshot refs under `prefix` (e.g. when their session's worktree is removed). */
  async dropSnapshots(cwd: string, prefix: string): Promise<void> {
    const root = await this.root(cwd)
    // A prefix ending in a slash matches whole folders of refs; otherwise it is a name prefix.
    const pattern = prefix.endsWith('/') ? prefix : `${prefix}*`
    const refs = await this.git(root, ['for-each-ref', '--format=%(refname)', pattern])
    for (const ref of refs.split('\n').filter(Boolean)) {
      await this.gitRaw(root, ['update-ref', '-d', ref])
    }
  }

  /**
   * Keeps the newest `keep` snapshot pairs under `folder` (a ref folder ending in a slash, whose
   * refs are named `<time>-before` / `<time>-after`) and drops the older ones. Returns how many
   * snapshots (pairs) went.
   */
  async pruneSnapshots(cwd: string, folder: string, keep: number): Promise<number> {
    if (!folder.endsWith('/')) throw new GitError('Snapshot folder must end in a slash')
    const root = await this.root(cwd)
    const refs = (await this.git(root, ['for-each-ref', '--format=%(refname)', folder]))
      .split('\n')
      .filter(Boolean)
    const turnOf = (ref: string) => ref.slice(folder.length).replace(/-(before|after)$/, '')
    // Names are base-36 times of equal length, so they sort in time order.
    const turns = [...new Set(refs.map(turnOf))].sort((a, b) =>
      a.length === b.length ? a.localeCompare(b) : a.length - b.length,
    )
    const old = new Set(turns.slice(0, Math.max(0, turns.length - keep)))
    for (const ref of refs) {
      if (old.has(turnOf(ref))) await this.gitRaw(root, ['update-ref', '-d', ref])
    }
    return old.size
  }

  /**
   * Commits exactly `paths`, including both sides of selected renames. Unrelated staged
   * files retain their staging state and remain outside this commit.
   */
  async commit(cwd: string, message: string, paths: string[], push = false) {
    const root = await this.root(cwd)
    return this.write(root, () => this.commitSelected(root, message, paths, push))
  }

  private async commitSelected(root: string, message: string, paths: string[], push: boolean) {
    if (!paths.length || !message.trim())
      throw new GitError('Choose files and enter a commit message')
    paths.forEach(assertRelative)
    const status = await this.status(root)
    const chosen = status.files.filter((f) => paths.includes(f.path))
    if (chosen.length !== new Set(paths).size)
      throw new GitError('The selected files changed. Refresh and try again.')
    const commitPaths = [
      ...new Set(chosen.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]))),
    ]
    // A staged rename has already removed oldPath from the index; adding it again fails. So does
    // adding a file whose deletion is staged (`git rm`): it is in neither the index nor the folder.
    // Those need no `add`; `commit --only` below still finds them through HEAD.
    const toAdd = chosen.filter((f) => !(f.status === 'D' && f.staged))
    if (toAdd.length > 0) await this.git(root, ['add', '-A', '--', ...toAdd.map((f) => f.path)])
    // --only excludes unrelated staged files and preserves their staging state.
    await this.git(root, ['commit', '--only', '-m', message.trim(), '--', ...commitPaths])
    const hash = (await this.git(root, ['rev-parse', 'HEAD'])).trim()
    if (push) {
      try {
        await this.pushDirect(root)
      } catch (err) {
        return { hash, pushed: false, pushError: err instanceof Error ? err.message : String(err) }
      }
    }
    return { hash, pushed: push }
  }

  /** Collect bounded, read-only context for a metadata draft. */
  async generationContext(cwd: string, kind: 'commit' | 'pr', paths: string[] = [], base?: string) {
    const root = await this.root(cwd)
    const limit = 80_000
    if (kind === 'commit') {
      if (!paths.length || paths.length > 200)
        throw new GitError('Select between 1 and 200 files to describe')
      paths.forEach(assertRelative)
      const status = await this.status(root)
      const selected = [...new Set(paths)]
      if (selected.some((p) => !status.files.some((f) => f.path === p)))
        throw new GitError('A selected file is no longer changed')
      let text = `Selected files:\n${selected.join('\n')}\n\n`
      let truncated = false
      const [baseline, trackedOutput] = await Promise.all([
        this.baseline(root),
        this.git(root, ['ls-files', '-z', '--', ...selected]),
      ])
      const tracked = new Set(trackedOutput.split('\0').map(toPosix))
      // Resolve repository metadata once, then limit concurrent diff processes and preserve order.
      batches: for (let offset = 0; offset < selected.length; offset += 4) {
        const batch = selected.slice(offset, offset + 4)
        const diffs = await Promise.all(
          batch.map((file) =>
            this.diffAtRoot(root, file, {
              baseline,
              tracked: tracked.has(file),
            }),
          ),
        )
        for (const diff of diffs) {
          if (text.length >= limit) {
            truncated = true
            break batches
          }
          text += `\nFile: ${JSON.stringify(diff.path)}\n${diff.patch || '[Binary file or no textual diff]'}\n`
          truncated ||= diff.truncated
        }
      }
      return { text: text.slice(0, limit), truncated: truncated || text.length > limit }
    }
    const info = await this.info(root)
    const branch = base?.trim() || info.defaultBranch
    if (
      !branch ||
      branch.startsWith('-') ||
      (await this.gitRaw(root, ['check-ref-format', '--branch', branch])).code !== 0
    )
      throw new GitError('Choose a valid base branch')
    const ref =
      (await this.gitRaw(root, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${branch}`]))
        .code === 0
        ? `refs/remotes/origin/${branch}`
        : branch
    await this.git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
    const commits = await this.git(root, ['log', '-n', '50', '--format=%s', `${ref}..HEAD`, '--'])
    if (!commits.trim())
      throw new GitError('There are no commits ahead of the base branch to describe')
    const patch = await this.git(root, [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      '--unified=3',
      `${ref}...HEAD`,
      '--',
    ])
    const text = `Branch: ${info.branch}\nBase: ${branch}\nCommits:\n${commits}\n\n${patch}`
    return { text: text.slice(0, limit), truncated: text.length > limit }
  }

  async push(cwd: string): Promise<void> {
    const root = await this.root(cwd)
    return this.write(root, () => this.pushDirect(root))
  }

  private async pushDirect(root: string): Promise<void> {
    const info = await this.info(root)
    if (info.detached || !info.branch) throw new GitError('Cannot push a detached HEAD')
    const args = info.upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']
    await this.git(root, args, 120_000)
  }

  async log(cwd: string): Promise<GitLog> {
    const root = await this.root(cwd)
    const info = await this.info(root)
    const base =
      info.defaultBranch && info.defaultBranch !== info.branch ? info.defaultBranch : undefined
    const baseExists =
      base !== undefined &&
      (await this.gitRaw(root, ['rev-parse', '--verify', '-q', base])).code === 0

    const head = await this.gitRaw(root, ['rev-parse', '--verify', '-q', 'HEAD'])
    if (head.code !== 0) return { unpushed: [], pushed: [], base: baseExists ? base : undefined }

    const range = baseExists ? [`${base}..HEAD`] : []
    const commits = parseLog(
      await this.git(root, [
        'log',
        '-n',
        '50',
        '--numstat',
        '--pretty=format:%x1e%H%x1f%an%x1f%at%x1f%s',
        ...range,
      ]),
    )

    let unpushedHashes: Set<string>
    if (info.upstream) {
      const unpushed = await this.git(root, ['rev-list', '@{u}..HEAD'])
      unpushedHashes = new Set(unpushed.split('\n').filter(Boolean))
    } else {
      unpushedHashes = new Set(commits.map((c) => c.hash))
    }
    return {
      unpushed: commits.filter((c) => unpushedHashes.has(c.hash)),
      pushed: commits.filter((c) => !unpushedHashes.has(c.hash)),
      base: baseExists ? base : undefined,
    }
  }

  async branches(cwd: string): Promise<GitBranch[]> {
    const root = await this.root(cwd)
    const refs = await this.git(root, [
      'for-each-ref',
      'refs/heads',
      '--sort=-committerdate',
      '--format=%(refname:short)%1f%(committerdate:unix)%1f%(HEAD)',
    ])
    const trees = await this.worktrees(root)
    return refs
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, at, head] = line.split('\x1f')
        const linked = trees.find((t) => t.branch === name && !t.main)
        return {
          name: name!,
          current: head === '*',
          at: Number(at) * 1000,
          worktree: linked?.path,
        }
      })
  }

  private async worktrees(
    cwd: string,
  ): Promise<{ path: string; branch?: string; main: boolean }[]> {
    const out = await this.git(cwd, ['worktree', 'list', '--porcelain'])
    return out
      .split('\n\n')
      .filter(Boolean)
      .map((block, i) => {
        const lines = block.split('\n')
        const wt = lines.find((l) => l.startsWith('worktree '))!.slice(9)
        const branch = lines
          .find((l) => l.startsWith('branch '))
          ?.slice(7)
          .replace('refs/heads/', '')
        return { path: path.resolve(wt), branch, main: i === 0 }
      })
  }

  /**
   * Creates a worktree for a session under `<repo>/.wt/`, on a new branch cut from `baseBranch`
   * (or on `branch` itself when it already exists and is free).
   */
  async createWorktree(
    cwd: string,
    options: { branch?: string; baseBranch?: string } = {},
  ): Promise<{ path: string; branch: string; baseBranch: string }> {
    const info = await this.info(cwd)
    if (!info.isRepo || !info.mainRoot) throw new GitError('Worktrees need a git repository')
    const base = options.baseBranch ?? info.defaultBranch ?? info.branch
    if (!base) throw new GitError('Could not tell which branch to start from')

    const branch = options.branch?.trim() || `beddcode/${randomBytes(3).toString('hex')}`
    const wtRoot = path.join(info.mainRoot, '.wt')
    let dir = path.join(wtRoot, slug(branch))
    for (let n = 2; existsSync(dir); n++) dir = path.join(wtRoot, `${slug(branch)}-${n}`)

    await this.excludeWorktreeDir(info.mainRoot)
    const exists =
      (
        await this.gitRaw(info.mainRoot, [
          'show-ref',
          '--verify',
          '--quiet',
          `refs/heads/${branch}`,
        ])
      ).code === 0
    if (exists) await this.git(info.mainRoot, ['worktree', 'add', dir, branch])
    else await this.git(info.mainRoot, ['worktree', 'add', '-b', branch, dir, base])
    return { path: dir, branch, baseBranch: base }
  }

  /**
   * Deletes a linked worktree. On Windows the folder can stay locked for a moment after the agent
   * that used it is stopped, so a refusal is retried before giving up. A folder left empty by an
   * earlier attempt is cleaned up too.
   */
  async removeWorktree(worktreePath: string): Promise<boolean> {
    const target = path.resolve(worktreePath)
    const info = await this.info(target).catch(() => null)
    if (!info?.isRepo || !info.isWorktree || !info.mainRoot) return removeLeftoverDir(target)

    const trees = await this.worktrees(info.mainRoot)
    if (!trees.some((t) => !t.main && t.path === target)) return false

    for (let attempt = 1; ; attempt++) {
      try {
        await this.git(info.mainRoot, ['worktree', 'remove', '--force', target])
        break
      } catch (err) {
        const locked = /permission denied|being used by another process|failed to delete/i.test(
          String(err),
        )
        if (!locked || attempt >= 6) throw err
        await new Promise((r) => setTimeout(r, 400 * attempt))
      }
    }
    // Git unregisters the worktree even when the folder itself could not be removed.
    removeLeftoverDir(target)
    return true
  }

  /** Keeps `.wt/` out of `git status` without touching the user's tracked .gitignore. */
  private async excludeWorktreeDir(mainRoot: string) {
    const gitDir = path.join(mainRoot, '.git')
    if (!isDirectory(gitDir)) return
    const file = path.join(gitDir, 'info', 'exclude')
    const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
    if (current.split(/\r?\n/).includes('/.wt/')) return
    mkdirSync(path.dirname(file), { recursive: true })
    appendFileSync(file, `${current.endsWith('\n') || current === '' ? '' : '\n'}/.wt/\n`)
  }
}

/** Removes an empty folder that sits directly inside a `.wt` directory (what a worktree leaves behind). */
function removeLeftoverDir(dir: string): boolean {
  try {
    if (path.basename(path.dirname(dir)) !== '.wt' || !statSync(dir).isDirectory()) return false
    if (readdirSync(dir).length > 0) return false
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    return !existsSync(dir)
  } catch {
    return false
  }
}

function slug(text: string) {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'session'
  )
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

function assertRelative(file: string) {
  if (path.isAbsolute(file) || toPosix(file).split('/').includes('..')) {
    throw new GitError(`Path must be inside the repository: ${file}`)
  }
}

function readText(file: string): string | null {
  try {
    if (statSync(file).size > MAX_FILE_BYTES) return null
    const buf = readFileSync(file)
    return buf.includes(0) ? null : buf.toString('utf8')
  } catch {
    return null
  }
}

function countLines(file: string): { added: number; removed: number } {
  const text = readText(file)
  if (text === null || text === '') return { added: 0, removed: 0 }
  return {
    added: text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length,
    removed: 0,
  }
}

/** `git diff --numstat -z` into path -> counts. Binary files count as 0. */
export function parseNumstat(out: string): Map<string, { added: number; removed: number }> {
  const result = new Map<string, { added: number; removed: number }>()
  const parts = out.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const head = parts[i]
    if (!head) continue
    const [a, r, name] = head.split('\t')
    let file = name
    if (file === '') {
      // Renames: the new path is the entry after the old one.
      file = parts[i + 2]
      i += 2
    }
    if (file === undefined) continue
    result.set(toPosix(file), {
      added: a === '-' ? 0 : Number(a),
      removed: r === '-' ? 0 : Number(r),
    })
  }
  return result
}

export function parseLog(out: string): GitCommit[] {
  return out
    .split('\x1e')
    .filter((r) => r.trim())
    .map((record) => {
      const [header, ...rest] = record.split('\n')
      const [hash, author, at, subject] = header!.split('\x1f')
      const files = rest
        .filter((l) => l.includes('\t'))
        .map((l) => {
          const [a, r, ...name] = l.split('\t')
          return {
            path: toPosix(name.join('\t')),
            added: a === '-' ? 0 : Number(a),
            removed: r === '-' ? 0 : Number(r),
          }
        })
      return {
        hash: hash!,
        author: author!,
        at: Number(at) * 1000,
        subject: subject ?? '',
        added: files.reduce((n, f) => n + f.added, 0),
        removed: files.reduce((n, f) => n + f.removed, 0),
        files,
      }
    })
}

function assertHash(hash: string) {
  if (!/^[0-9a-f]{40,64}$/.test(hash)) throw new GitError('Not a snapshot')
}

function patchOf(file: string, out: string): GitDiff {
  if (/^Binary files /m.test(out))
    return { path: file, patch: '', added: 0, removed: 0, truncated: true }
  const lines = out.split('\n')
  const start = lines.findIndex((l) => l.startsWith('@@'))
  const body = start === -1 ? [] : lines.slice(start)
  if (body.at(-1) === '') body.pop()
  const added = body.filter((l) => l.startsWith('+')).length
  const removed = body.filter((l) => l.startsWith('-')).length
  const truncated = body.length > MAX_PATCH_LINES
  return { path: file, patch: body.slice(0, MAX_PATCH_LINES).join('\n'), added, removed, truncated }
}
