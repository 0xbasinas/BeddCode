import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  BookOpen,
  Bug,
  Check,
  ChevronDown,
  FileSearch,
  Folder,
  GitBranch,
  GitPullRequest,
  Monitor,
} from 'lucide-react'
import type { GitBranch as Branch, GitInfo, ProviderInstance } from '@beddcode/contracts'
import { Composer } from '../composer/Composer.tsx'
import { ModelMenu, type ModelChoice } from '../composer/Menus.tsx'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { folderName, timeAgo } from '../../ui/format.ts'
import { hostRequest, readyProviders, useHostStore } from '../../stores/host.ts'

const QUICK_STARTS = [
  {
    icon: Bug,
    label: 'Fix a failing test',
    prompt: 'Find the failing test, work out why it fails, fix it, and run the tests to confirm.',
  },
  {
    icon: FileSearch,
    label: 'Review uncommitted changes',
    prompt: 'Review my uncommitted changes and point out bugs, risky spots, and missing tests.',
  },
  {
    icon: GitPullRequest,
    label: 'Open a PR for this branch',
    prompt:
      'Write a clear title and description for a pull request from this branch, and tell me what it changes.',
  },
  {
    icon: BookOpen,
    label: 'Explain how this repo works',
    prompt: 'Explain how this repository is organised and how its main pieces fit together.',
  },
]

interface Workspace {
  mode: 'worktree' | 'local'
  baseBranch?: string
}

interface RepoState {
  info: GitInfo
  branches: Branch[]
}

export function NewSession({ initialProject }: { initialProject?: string }) {
  const navigate = useNavigate()
  const { providers, connection, host, replica, projects } = useHostStore()
  const [text, setText] = useState('')
  const [instanceId, setInstanceId] = useState<string>()
  const [modeId, setModeId] = useState<string>()
  const [choice, setChoice] = useState<ModelChoice>({ model: undefined, effort: undefined })
  const [chosenFolder, setChosenFolder] = useState(initialProject ?? '')
  const [workspace, setWorkspace] = useState<Workspace>({ mode: 'local' })
  const [repo, setRepo] = useState<RepoState | null | 'loading'>('loading')

  const ready = readyProviders(providers)
  const agent: ProviderInstance | undefined = ready.find((p) => p.id === instanceId) ?? ready[0]

  // Changing agent resets choices that only make sense for the previous one.
  useEffect(() => {
    setModeId(undefined)
    setChoice({ model: undefined, effort: undefined })
  }, [agent?.id])

  const folder = chosenFolder || projects[0]?.path || host?.defaultCwd || ''

  // Look at the folder's repository whenever it changes: branches for the picker, and whether
  // worktrees are possible at all.
  useEffect(() => {
    if (!folder || connection !== 'connected') return
    let cancelled = false
    setRepo('loading')
    Promise.all([
      hostRequest('git.info', { cwd: folder }),
      hostRequest('git.branches', { cwd: folder }),
    ])
      .then(([info, branches]) => {
        if (cancelled) return
        setRepo(info.isRepo ? { info, branches } : null)
        // Isolated worktrees are the default whenever there is a commit to branch from.
        setWorkspace(
          info.isRepo && info.defaultBranch && branches.length > 0
            ? { mode: 'worktree', baseBranch: info.defaultBranch }
            : { mode: 'local' },
        )
      })
      .catch(() => {
        if (cancelled) return
        setRepo(null)
        setWorkspace({ mode: 'local' })
      })
    return () => {
      cancelled = true
    }
  }, [folder, connection])

  const modes = agent?.capabilities.permissionModes ?? []
  const recentFolders = useMemo(
    () =>
      [
        ...new Set([
          ...projects.map((p) => p.path),
          ...replica.order.map((id) => replica.sessions[id]!.projectPath),
        ]),
      ].slice(0, 8),
    [replica, projects],
  )

  const send = async (value: string, attachments: string[]) => {
    if (!agent) throw new Error('No agent is ready on this host')
    const { createSession, prompt } = useHostStore.getState()
    const useWorktree = repo && repo !== 'loading' && workspace.mode === 'worktree'
    const sessionId = await createSession({
      instanceId: agent.id,
      cwd: folder || undefined,
      permissionMode: modeId,
      model: choice.model,
      effort: choice.effort,
      workspace: useWorktree ? { mode: 'worktree', baseBranch: workspace.baseBranch } : undefined,
    })
    await prompt(sessionId, value, attachments)
    void navigate({ to: '/session/$sessionId', params: { sessionId } })
  }

  return (
    <main className="panel new-session">
      <header className="thread-head">
        <h1>New session</h1>
        <div className="thread-meta">Nothing runs until you send</div>
      </header>
      <div className="new-body">
        <h2>{agent ? `What should ${agent.label} work on?` : 'What should we work on?'}</h2>
        <p>
          {connection !== 'connected'
            ? 'Connecting to your host…'
            : agent
              ? 'Describe a task, paste an issue link, or ask a question.'
              : 'No agent is ready on this host yet. Install and sign in to Claude Code or Codex, or add an ACP agent.'}
        </p>
        <Composer
          text={text}
          onTextChange={setText}
          placeholder="Describe a task, or paste an issue link…"
          busy={false}
          disabled={connection !== 'connected' || !agent}
          autoFocus
          onSend={send}
          modes={modes}
          modeId={modeId}
          onModeChange={setModeId}
          modelSlot={
            agent && (
              <ModelMenu
                models={agent.capabilities.models ?? []}
                efforts={agent.capabilities.efforts ?? []}
                value={choice}
                onChange={setChoice}
              />
            )
          }
          footer={
            <div className="footer-bar">
              <AgentChip agents={providers} current={agent} onPick={setInstanceId} />
              <span className="sep" />
              <FolderChip
                value={folder}
                recent={recentFolders}
                onChange={setChosenFolder}
                onAdd={async (p) => {
                  const added = await useHostStore.getState().addProject(p)
                  setChosenFolder(added.path)
                }}
              />
              <span className="chip-lite static">
                <Monitor size={14} /> {host?.name ?? 'This PC'}
              </span>
              <span className="spacer" />
              {repo && repo !== 'loading' && (
                <WorkspaceChip repo={repo} workspace={workspace} onChange={setWorkspace} />
              )}
            </div>
          }
        />
        <div className="quick">
          <div className="quick-title">Quick starts</div>
          <div className="quick-grid">
            {QUICK_STARTS.map(({ icon: Icon, label, prompt }) => (
              <button key={label} onClick={() => setText(prompt)}>
                <Icon size={18} /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}

function initials(label: string) {
  return label
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()
}

const statusText: Record<ProviderInstance['status'], string> = {
  ready: 'Ready',
  'needs-sign-in': 'Needs sign-in',
  'not-installed': 'Not installed',
  error: 'Unavailable',
}

function AgentChip({
  agents,
  current,
  onPick,
}: {
  agents: ProviderInstance[]
  current: ProviderInstance | undefined
  onPick(id: string): void
}) {
  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button className="chip-lite" onClick={toggle} aria-label="Agent">
          <span className="avatar">{current ? initials(current.label) : '–'}</span>
          {current?.label ?? 'No agent'} <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-heading">Agent</div>
          {agents.map((a) => (
            <button
              key={a.id}
              className="menu-row"
              disabled={a.status !== 'ready'}
              onClick={() => {
                onPick(a.id)
                close()
              }}
            >
              <span className="avatar">{initials(a.label)}</span>
              <span className="menu-text">
                <span className="menu-title">{a.label}</span>
                {a.status !== 'ready' && <span className="menu-desc">{statusText[a.status]}</span>}
              </span>
              {a.status !== 'ready' && <span className="dot warn" />}
            </button>
          ))}
        </>
      )}
    </Dropdown>
  )
}

function FolderChip({
  value,
  recent,
  onChange,
  onAdd,
}: {
  value: string
  recent: string[]
  onChange(path: string): void
  onAdd(path: string): Promise<void>
}) {
  const [error, setError] = useState<string>()
  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button className="chip-lite" onClick={toggle} aria-label="Folder" title={value}>
          <Folder size={14} /> {value ? folderName(value) : 'Choose a folder'}{' '}
          <ChevronDown size={13} />
        </button>
      )}
      panelClassName="wide"
    >
      {(close) => (
        <>
          <div className="menu-heading">Add a folder on this host</div>
          <input
            className="path-input"
            placeholder="Absolute path, e.g. C:\src\my-app"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return
              const input = e.currentTarget.value.trim()
              if (!input) return
              onAdd(input).then(
                () => close(),
                (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
              )
            }}
            autoFocus
          />
          {error && <div className="composer-error menu-error">{error}</div>}
          {recent.length > 0 && <div className="menu-heading">Projects</div>}
          {recent.map((p) => (
            <button
              key={p}
              className="menu-row"
              aria-checked={p === value}
              onClick={() => {
                onChange(p)
                close()
              }}
            >
              <span className="menu-text">
                <span className="menu-title">{folderName(p)}</span>
                <span className="menu-desc">{p}</span>
              </span>
              {p === value && <Check size={16} />}
            </button>
          ))}
        </>
      )}
    </Dropdown>
  )
}

/** Where the agent works: an isolated worktree cut from a branch, or the checkout itself. */
function WorkspaceChip({
  repo,
  workspace,
  onChange,
}: {
  repo: RepoState
  workspace: Workspace
  onChange(next: Workspace): void
}) {
  const base = workspace.baseBranch ?? repo.info.defaultBranch ?? repo.info.branch ?? 'main'
  const label =
    workspace.mode === 'worktree'
      ? `New worktree from ${base}`
      : `Work in the main checkout${repo.info.branch ? ` (${repo.info.branch})` : ''}`

  return (
    <Dropdown
      align="end"
      panelClassName="wide"
      trigger={({ toggle }) => (
        <button className="chip-lite" onClick={toggle} aria-label="Workspace">
          <GitBranch size={14} /> {label} <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <>
          <button
            className="menu-row"
            aria-checked={workspace.mode === 'worktree'}
            onClick={() => {
              onChange({ mode: 'worktree', baseBranch: base })
              close()
            }}
          >
            <span className="menu-text">
              <span className="menu-title">New worktree from {base}</span>
              <span className="menu-desc">Isolated copy, safe to run in parallel</span>
            </span>
            {workspace.mode === 'worktree' && <Check size={16} />}
          </button>
          <button
            className="menu-row"
            aria-checked={workspace.mode === 'local'}
            onClick={() => {
              onChange({ mode: 'local' })
              close()
            }}
          >
            <span className="menu-text">
              <span className="menu-title">Work in the main checkout</span>
              <span className="menu-desc">Edits {repo.info.root} directly</span>
            </span>
            {workspace.mode === 'local' && <Check size={16} />}
          </button>
          {repo.branches.length > 0 && <div className="menu-sep" />}
          {repo.branches.length > 0 && <div className="menu-heading">Start the worktree from</div>}
          {repo.branches.map((b) => (
            <button
              key={b.name}
              className="menu-row"
              aria-checked={workspace.mode === 'worktree' && base === b.name}
              onClick={() => {
                onChange({ mode: 'worktree', baseBranch: b.name })
                close()
              }}
            >
              <span className="menu-text">
                <code className="menu-title">{b.name}</code>
              </span>
              <span className="muted">
                {b.worktree ? 'worktree' : b.current ? 'current' : `${timeAgo(b.at)} ago`}
              </span>
            </button>
          ))}
        </>
      )}
    </Dropdown>
  )
}
