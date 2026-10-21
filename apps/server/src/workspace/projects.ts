import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Project } from '@beddcode/contracts'
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

  private paths(): string[] {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { paths?: string[] }
      return Array.isArray(data.paths) ? data.paths : []
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new Error(`Could not read ${this.file}: ${err instanceof Error ? err.message : err}`)
    }
  }

  private write(paths: string[]) {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, paths }, null, 2))
    renameSync(tmp, this.file)
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
