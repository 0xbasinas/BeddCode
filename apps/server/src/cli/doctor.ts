import type { TailnetStatus } from '@beddcode/contracts'
import type { RunResult } from '@beddcode/shared'
import type { HostHealth } from './health.ts'

export interface Check {
  name: string
  level: 'ok' | 'warn' | 'fail'
  detail: string
  /** What to do about it, for a warn or fail. */
  fix?: string
}

export interface DoctorDeps {
  port: number
  health(port: number): Promise<HostHealth | null>
  /** The full path of a program on PATH, or null. */
  find(name: string): string | null
  run(file: string, args: string[]): Promise<RunResult>
  tailnet(): Promise<TailnetStatus>
  dataDir: string
  dirExists(dir: string): boolean
  /** Whether the background host (`beddcode host install`) is set up; left out, it is not checked. */
  serviceInstalled?(): Promise<boolean>
  platform?: NodeJS.Platform
}

/** The agent CLIs BeddCode can drive. At least one has to be installed to start a session. */
const AGENTS = [
  { name: 'claude', login: 'claude auth login' },
  { name: 'codex', login: 'codex login' },
  { name: 'grok', login: 'grok login' },
]

async function version(deps: DoctorDeps, file: string): Promise<string | null> {
  try {
    const res = await deps.run(file, ['--version'])
    return res.code === 0 ? (res.stdout.trim().split(/\r?\n/)[0] ?? '') : null
  } catch {
    return null
  }
}

/** Looks at everything that usually goes wrong, and says how to fix it. Never throws. */
export async function doctor(deps: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = []

  const health = await deps.health(deps.port)
  checks.push(
    health
      ? {
          name: 'Host',
          level: 'ok',
          detail: `${health.name} on port ${deps.port} (${health.version})`,
        }
      : {
          name: 'Host',
          level: 'warn',
          detail: `nothing answers on port ${deps.port}`,
          fix: 'Open the BeddCode app, run `beddcode serve`, or keep one running in the background with `beddcode host install`.',
        },
  )

  if (deps.serviceInstalled) {
    const installed = await deps.serviceInstalled().catch(() => false)
    const start =
      deps.platform === 'win32'
        ? 'schtasks /Run /TN "BeddCode Server"'
        : 'systemctl --user start beddcode-server'
    checks.push(
      !installed
        ? {
            name: 'Background host',
            level: 'ok',
            detail:
              'not installed; the app or `beddcode serve` runs the host (`beddcode host install` keeps one running)',
          }
        : health
          ? { name: 'Background host', level: 'ok', detail: 'installed, starts at sign-in' }
          : {
              name: 'Background host',
              level: 'warn',
              detail: 'installed, but nothing answers on the port',
              fix: `Start it with \`${start}\`; \`beddcode logs\` shows why it stopped.`,
            },
    )
  }

  const git = deps.find('git')
  const gitVersion = git ? await version(deps, git) : null
  checks.push(
    gitVersion
      ? { name: 'git', level: 'ok', detail: gitVersion }
      : {
          name: 'git',
          level: 'fail',
          detail: 'not found on PATH',
          fix: 'Install git; the Git pane, worktrees and undo need it.',
        },
  )

  let agents = 0
  for (const agent of AGENTS) {
    const exe = deps.find(agent.name)
    const v = exe ? await version(deps, exe) : null
    if (v) {
      agents++
      checks.push({
        name: agent.name,
        level: 'ok',
        detail: `${v} (sign in with \`${agent.login}\` if it asks)`,
      })
    } else {
      checks.push({ name: agent.name, level: 'warn', detail: 'not installed (optional)' })
    }
  }
  if (agents === 0) {
    checks.push({
      name: 'Agents',
      level: 'fail',
      detail: 'no agent CLI found',
      fix: 'Install Claude Code, Codex or another agent and sign in; BeddCode runs the ones you have.',
    })
  }

  const gh = deps.find('gh')
  let ghSignedIn = false
  if (gh) {
    try {
      ghSignedIn = (await deps.run(gh, ['auth', 'status'])).code === 0
    } catch {
      ghSignedIn = false
    }
  }
  checks.push(
    ghSignedIn
      ? { name: 'GitHub', level: 'ok', detail: 'gh is signed in' }
      : {
          name: 'GitHub',
          level: 'warn',
          detail: gh ? 'gh is not signed in' : 'gh is not installed',
          fix: 'Pull requests need it: install the GitHub CLI and run `gh auth login`.',
        },
  )

  const tailnet = await deps.tailnet().catch(() => null)
  checks.push(
    tailnet?.state === 'running'
      ? {
          name: 'Tailscale',
          level: 'ok',
          detail: tailnet.self?.dnsName || tailnet.self?.ip || 'running',
        }
      : {
          name: 'Tailscale',
          level: 'warn',
          detail:
            tailnet?.state === 'not-installed'
              ? 'not installed'
              : (tailnet?.message ?? 'not running'),
          fix: 'Only needed to reach this machine from your phone or another computer.',
        },
  )

  checks.push(
    deps.dirExists(deps.dataDir)
      ? { name: 'Data', level: 'ok', detail: deps.dataDir }
      : {
          name: 'Data',
          level: 'warn',
          detail: `${deps.dataDir} does not exist yet`,
          fix: 'It is created when the host first runs.',
        },
  )

  return checks
}

const MARK = { ok: '✓', warn: '!', fail: '✗' } as const

export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length))
  return checks
    .map((c) => {
      const line = `${MARK[c.level]} ${c.name.padEnd(width)}  ${c.detail}`
      return c.fix && c.level !== 'ok' ? `${line}\n  ${' '.repeat(width)}  → ${c.fix}` : line
    })
    .join('\n')
}

/** Exit code: 1 when something that stops BeddCode from working failed. */
export const doctorExitCode = (checks: Check[]) => (checks.some((c) => c.level === 'fail') ? 1 : 0)
