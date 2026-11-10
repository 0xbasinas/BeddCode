import { statSync } from 'node:fs'
import path from 'node:path'
import { createLogger, readJsonFile, writeFileAtomic } from '@beddcode/shared'
import type { McpServerPolicy, Project, ProjectScript } from '@beddcode/contracts'
import type { GitService } from './git.ts'

/**
 * Folders the user added to work in. Kept in a small JSON file; the folder's own git state is
 * read live, never stored.
 */
export class ProjectStore {
  constructor(
    private readonly file: string,
    private readonly git: GitService,
    private readonly onChange?: (path: string, added: boolean) => void,
  ) {}

  private read(): {
    paths: string[]
    scripts: Record<string, ProjectScript[]>
    instructions: Record<string, string>
    backends: Record<string, 'sdk' | 'cli'>
    mcpPolicies: Record<string, Record<string, McpServerPolicy>>
  } {
    const read = readJsonFile<{
      paths?: unknown
      scripts?: Record<string, ProjectScript[]>
      instructions?: Record<string, string>
      backends?: Record<string, unknown>
      mcpPolicies?: Record<string, Record<string, McpServerPolicy>>
    }>(this.file)
    if (read.status === 'corrupt') {
      createLogger('projects').error(
        `${this.file} is damaged (${read.error}); starting with no projects.` +
          (read.quarantined ? ` The old file was kept as ${read.quarantined}.` : ''),
      )
    }
    if (read.status !== 'ok' || !read.value || typeof read.value !== 'object')
      return { paths: [], scripts: {}, instructions: {}, backends: {}, mcpPolicies: {} }
    const data = read.value
    return {
      paths: Array.isArray(data.paths)
        ? data.paths.filter((p): p is string => typeof p === 'string')
        : [],
      scripts: data.scripts && typeof data.scripts === 'object' ? data.scripts : {},
      instructions:
        data.instructions && typeof data.instructions === 'object' ? data.instructions : {},
      backends: Object.fromEntries(
        Object.entries(data.backends ?? {}).filter(([, v]) => v === 'sdk' || v === 'cli'),
      ) as Record<string, 'sdk' | 'cli'>,
      mcpPolicies: data.mcpPolicies && typeof data.mcpPolicies === 'object' ? data.mcpPolicies : {},
    }
  }

  private paths(): string[] {
    return this.read().paths
  }

  private write(
    paths: string[],
    scripts = this.read().scripts,
    instructions = this.read().instructions,
    backends = this.read().backends,
    mcpPolicies = this.read().mcpPolicies,
  ) {
    // Scripts of folders no longer in the list are dropped.
    const kept = Object.fromEntries(
      Object.entries(scripts).filter(
        ([folder, list]) => list.length > 0 && paths.some((p) => samePath(p, folder)),
      ),
    )
    const rules = Object.fromEntries(
      Object.entries(instructions).filter(
        ([folder, value]) =>
          typeof value === 'string' && value.length > 0 && paths.some((p) => samePath(p, folder)),
      ),
    )
    const keptBackends = Object.fromEntries(
      Object.entries(backends).filter(([p]) => paths.some((folder) => samePath(folder, p))),
    )
    const keptPolicies = Object.fromEntries(
      Object.entries(mcpPolicies).flatMap(([p, servers]) =>
        paths.some((folder) => samePath(folder, p)) && Object.keys(servers).length > 0
          ? [[p, servers] as const]
          : [],
      ),
    )
    const data = {
      version: 1,
      paths,
      ...(Object.keys(kept).length ? { scripts: kept } : {}),
      ...(Object.keys(rules).length ? { instructions: rules } : {}),
      ...(Object.keys(keptBackends).length ? { backends: keptBackends } : {}),
      ...(Object.keys(keptPolicies).length ? { mcpPolicies: keptPolicies } : {}),
    }
    writeFileAtomic(this.file, JSON.stringify(data, null, 2))
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

  instructionsFor(folder: string): string {
    const { instructions } = this.read()
    const key = Object.keys(instructions).find((p) => samePath(p, folder))
    return key && typeof instructions[key] === 'string' ? instructions[key] : ''
  }

  async setInstructions(folder: string, value: string): Promise<Project> {
    const { paths, scripts, instructions } = this.read()
    const stored = paths.find((p) => samePath(p, folder))
    if (!stored) throw new Error(`Not an added folder: ${folder}`)
    const next = Object.fromEntries(
      Object.entries(instructions).filter(([p]) => !samePath(p, stored)),
    )
    next[stored] = value
    this.write(paths, scripts, next)
    return this.describe(stored)
  }

  backendFor(folder: string): 'sdk' | 'cli' | undefined {
    const backends = this.read().backends
    const key = Object.keys(backends).find((p) => samePath(p, folder))
    return key ? backends[key] : undefined
  }

  /** The added project a folder belongs to: itself, or the repository root for a worktree. */
  projectRootFor(folder: string): string | undefined {
    const resolved = path.resolve(folder)
    const paths = this.paths()
    const exact = paths.find((p) => samePath(p, resolved))
    if (exact) return exact
    // Longest project path the folder is inside (a worktree lives under `<repo>/.wt/…`).
    let best: string | undefined
    for (const p of paths) {
      const rel = path.relative(path.resolve(p), resolved)
      if (rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)) {
        if (!best || p.length > best.length) best = p
      }
    }
    return best
  }

  /** The MCP server policies set for the project a folder belongs to. */
  mcpPoliciesFor(folder: string | undefined): Record<string, McpServerPolicy> {
    if (!folder) return {}
    const root = this.projectRootFor(folder)
    if (!root) return {}
    const { mcpPolicies } = this.read()
    const key = Object.keys(mcpPolicies).find((p) => samePath(p, root))
    return key ? (mcpPolicies[key] ?? {}) : {}
  }

  /** Sets or clears (null) one server's policy for the project containing `folder`. */
  async setMcpPolicy(
    folder: string | undefined,
    name: string,
    policy: McpServerPolicy | null,
  ): Promise<{ name: string; policy: McpServerPolicy | null }> {
    const root = folder ? this.projectRootFor(folder) : undefined
    if (!root) throw new Error(`${folder ?? 'This folder'} is not an added project`)
    const { paths, scripts, instructions, backends, mcpPolicies } = this.read()
    const next = Object.fromEntries(
      Object.entries(mcpPolicies).filter(([p]) => !samePath(p, root)),
    ) as Record<string, Record<string, McpServerPolicy>>
    const servers = { ...mcpPolicies[root] }
    if (policy) servers[name] = policy
    else delete servers[name]
    if (Object.keys(servers).length > 0) next[root] = servers
    this.write(paths, scripts, instructions, backends, next)
    return { name, policy }
  }

  async setClaudeBackend(folder: string, backend: 'sdk' | 'cli' | null): Promise<Project> {
    const { paths, scripts, backends } = this.read()
    const stored = paths.find((p) => samePath(p, folder))
    if (!stored) throw new Error(`Not an added folder: ${folder}`)
    const next = Object.fromEntries(Object.entries(backends).filter(([p]) => !samePath(p, stored)))
    if (backend) next[stored] = backend
    this.write(paths, scripts, this.read().instructions, next)
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
    this.onChange?.(root, true)
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
    this.onChange?.(folder, false)
    return true
  }

  private async describe(folder: string): Promise<Project> {
    const info = isDirectory(folder) ? await this.git.info(folder).catch(() => null) : null
    return {
      path: folder,
      name: path.basename(folder) || folder,
      isRepo: info?.isRepo ?? false,
      instructions: this.instructionsFor(folder),
      branch: info?.branch,
      claudeBackend: this.backendFor(folder),
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
