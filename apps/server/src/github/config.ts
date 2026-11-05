import { readFileSync } from 'node:fs'

/** What to do before a step that changes GitHub: `auto` goes ahead, `ask` waits for you, `never` skips it. */
export type Approval = 'auto' | 'ask' | 'never'

/** How a kind of job runs. Anything left out falls back to `defaults`, then to the agent's own default. */
export interface RunSettings {
  /** Agent name or id, matched against the host's agents (for example `claude` or `codex`). */
  agent?: string
  model?: string
  effort?: string
  /** The agent's permission mode for the session, for example one that asks before running tools. */
  permissionMode?: string
}

export interface RepoSettings extends RunSettings {
  /** The local clone this host works in. */
  path: string
  approval?: Partial<ApprovalPolicy>
}

export interface ApprovalPolicy {
  /** Pushing a branch (a new one for an issue, or the pull request's own branch). */
  push: Approval
  /** Opening a pull request for a branch that was pushed. */
  pullRequest: Approval
  /** Rewriting a pull request's branch (rebase). Always a lease-protected force push. */
  forcePush: Approval
}

export interface GithubConfig {
  /** Where the Worker is, for example `https://beddcode-github.you.workers.dev`. */
  workerUrl: string
  /** The Worker's `HOST_TOKEN`. */
  hostToken: string
  /** Names this host in replies and on the phone. Defaults to the computer's name. */
  label?: string
  /** With several hosts online for a repo, the lowest number is asked first. */
  priority: number
  /** How many jobs this host runs at once. */
  maxConcurrent: number
  repos: Record<string, RepoSettings>
  defaults: RunSettings
  /** Settings per command, over `defaults`: keys `fix`, `review`, `fix-ci`, `explain`, `rebase`. */
  commands: Record<string, RunSettings>
  approval: ApprovalPolicy
}

export const DEFAULT_APPROVAL: ApprovalPolicy = { push: 'ask', pullRequest: 'auto', forcePush: 'ask' }

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const approval = (v: unknown, fallback: Approval): Approval =>
  v === 'auto' || v === 'ask' || v === 'never' ? v : fallback

function run(raw: unknown): RunSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    agent: str(o.agent),
    model: str(o.model),
    effort: str(o.effort),
    permissionMode: str(o.permissionMode),
  }
}

function policy(raw: unknown, base: ApprovalPolicy): ApprovalPolicy {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    push: approval(o.push, base.push),
    pullRequest: approval(o.pullRequest, base.pullRequest),
    forcePush: approval(o.forcePush, base.forcePush),
  }
}

/** Reads `github.json`. Returns undefined when the file is missing or not set up, so the bridge stays off. */
export function readGithubConfig(file: string): GithubConfig | undefined {
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
  const workerUrl = str(raw.workerUrl)?.replace(/\/+$/, '')
  const hostToken = str(raw.hostToken)
  if (!workerUrl || !hostToken || !/^https:\/\//.test(workerUrl) && !/^http:\/\/(127\.0\.0\.1|localhost)/.test(workerUrl))
    return undefined
  const approvals = policy(raw.approval, DEFAULT_APPROVAL)
  const repos: GithubConfig['repos'] = {}
  for (const [name, value] of Object.entries((raw.repos ?? {}) as Record<string, unknown>)) {
    const o = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
    const repoPath = str(o.path)
    if (!repoPath || !/^[\w.-]+\/[\w.-]+$/.test(name)) continue
    repos[name.toLowerCase()] = {
      path: repoPath,
      ...run(o),
      approval: o.approval ? policy(o.approval, approvals) : undefined,
    }
  }
  const commands: GithubConfig['commands'] = {}
  for (const [name, value] of Object.entries((raw.commands ?? {}) as Record<string, unknown>))
    commands[name] = run(value)
  return {
    workerUrl,
    hostToken,
    label: str(raw.label),
    priority: Number.isFinite(Number(raw.priority)) ? Number(raw.priority) : 0,
    maxConcurrent: Math.min(8, Math.max(1, Number(raw.maxConcurrent) || 2)),
    repos,
    defaults: run(raw.defaults),
    commands,
    approval: approvals,
  }
}

/** The settings for one job, each layer over the last: defaults, the repo's, the command's, then what the comment asked for. */
export function settingsFor(
  config: GithubConfig,
  repo: string,
  verb: string,
  asked: RunSettings,
): RunSettings {
  const layers = [config.defaults, config.repos[repo.toLowerCase()] ?? {}, config.commands[verb] ?? {}, asked]
  const out: RunSettings = {}
  for (const layer of layers)
    for (const key of ['agent', 'model', 'effort', 'permissionMode'] as const)
      if (layer[key]) out[key] = layer[key]
  return out
}

export function approvalFor(config: GithubConfig, repo: string): ApprovalPolicy {
  return { ...config.approval, ...(config.repos[repo.toLowerCase()]?.approval ?? {}) }
}
