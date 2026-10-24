import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Project, ProjectScript } from '@beddcode/contracts'
import type { GitService } from './git.ts'

/**
 * Folders the user added to work in. Kept in a small JSON file; the folder's own git state is
 * read live, never stored.
 */
export class ProjectStore {
  constructor(
    private readonly file: string,
    private readonly git: GitService,
  ) {}

  private read(): { paths: string[]; scripts: Record<string, ProjectScript[]> } {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as {
        paths?: string[]
        scripts?: Record<string, ProjectScript[]>
      }
      return {
        paths: Array.isArray(data.paths) ? data.paths : [],
        scripts: data.scripts && typeof data.scripts === 'object' ? data.scripts : {},
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { paths: [], scripts: {} }
      throw new Error(`Could not read ${this.file}: ${err instanceof Error ? err.message : err}`)
    }
  }

  private paths(): string[] {
    return this.read().paths
  }

  private write(paths: string[], scripts = this.read().scripts) {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    // Scripts of folders no longer in the list are dropped.
    const kept = Object.fromEntries(
      Object.entries(scripts).filter(
        ([folder, list]) => list.length > 0 && paths.some((p) => samePath(p, folder)),
      ),
    )
    const data =
      Object.keys(kept).length > 0 ? { version: 1, paths, scripts: kept } : { version: 1, paths }
    writeFileSync(tmp, JSON.stringify(data, null, 2))
    renameSync(tmp, this.file)
  }

  /** The saved commands of a folder (of the repository a worktree belongs to, for a worktree). */
  scriptsFor(folder: string): ProjectScript[] {
    const { scripts } = this.read()
    const key = Object.keys(scripts).find((p) => samePath(p, folder))
    return key ? (scripts[key] ?? []) : []
  }

  /** Replaces an added folder's saved commands. */
  async setScripts(folder: string, list: ProjectScript[]): Promise<Project> {
    const { paths, scripts } = this.read()
    const stored = paths.find((p) => samePath(p, folder))
    if (!stored) throw new Error(`Not an added folder: ${folder}`)
    const ids = new Set(list.map((s) => s.id))
    if (ids.size !== list.length) throw new Error('Each script needs its own id')
    const next = Object.fromEntries(Object.entries(scripts).filter(([p]) => !samePath(p, stored)))
    next[stored] = list
    this.write(paths, next)
    return this.describe(stored)
  }

  async list(): Promise<Project[]> {
    const out: Project[] = []
    for (const p of this.paths()) out.push(await this.describe(p))
    return out
  }

  /** Adds a folder. Inside a repository the repository's main checkout is what gets stored. */
  async add(folder: string): Promise<Project> {
    const resolved = path.resolve(folder)
    if (!isDirectory(resolved)) throw new Error(`Folder does not exist: ${resolved}`)
    const info = await this.git.info(resolved)
    const root = info.isRepo ? (info.mainRoot ?? info.root ?? resolved) : resolved
    const paths = this.paths()
    if (!paths.some((p) => samePath(p, root))) this.write([...paths, root])
    return this.describe(root)
  }

  /**
   * Makes an added folder a git repository. Only folders already in the list qualify, so this
   * cannot be pointed at an arbitrary path, and a folder that already is a repository is left as is.
   */
  async initGit(folder: string): Promise<Project> {
    const stored = this.paths().find((p) => samePath(p, folder))
    if (!stored) throw new Error(`Not an added folder: ${folder}`)
    if (!isDirectory(stored)) throw new Error(`Folder does not exist: ${stored}`)
    const info = await this.git.info(stored)
    if (!info.isRepo) await this.git.init(stored)
    return this.describe(stored)
  }

  remove(folder: string): boolean {
    const paths = this.paths()
    const next = paths.filter((p) => !samePath(p, folder))
    if (next.length === paths.length) return false
    this.write(next)
    return true
  }

  private async describe(folder: string): Promise<Project> {
    const info = isDirectory(folder) ? await this.git.info(folder).catch(() => null) : null
    return {
      path: folder,
      name: path.basename(folder) || folder,
      isRepo: info?.isRepo ?? false,
      branch: info?.branch,
      ...(this.scriptsFor(folder).length > 0 ? { scripts: this.scriptsFor(folder) } : {}),
    }
  }
}

function samePath(a: string, b: string) {
  // Windows paths are case-insensitive; elsewhere they are not.
  const norm = (p: string) =>
    process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p)
  return norm(a) === norm(b)
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}
