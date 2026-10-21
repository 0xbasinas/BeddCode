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
  Server,
} from 'lucide-react'
import type { GitBranch as Branch, GitInfo, ProviderInstance } from '@beddcode/contracts'
import { Composer } from '../composer/Composer.tsx'
import { ModelMenu, type ModelChoice } from '../composer/Menus.tsx'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { folderName, timeAgo } from '../../ui/format.ts'
import {
  addProject,
  createSession,
  hostRequest,
  prompt,
  readyProviders,
  useHostStore,
  useRuntime,
} from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { Welcome, setupWasSkipped, skipSetup } from './Welcome.tsx'
import { useAppPreferences } from '../../stores/appPreferences.ts'
import { modelChoice } from '../../ui/models.ts'
import {
  agentDefaults,
  defaultAgent,
  hostDefaults,
  usePreferences,
} from '../../stores/preferences.ts'

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

export function NewSession({
  initialProject,
  initialHost,
}: {
  initialProject?: string
  initialHost?: string
}) {
  const navigate = useNavigate()
  const entries = useHostStore((s) => s.entries)
  const defaultHostKey = useAppPreferences((s) => s.values.defaultHostKey)
  const defaultWorkspace = useAppPreferences((s) => s.values.defaultWorkspace)
  const [hostKey, setHostKey] = useState(
    entries.some((e) => e.key === (initialHost ?? defaultHostKey))
      ? (initialHost ?? defaultHostKey)
      : LOCAL_HOST_KEY,
  )
  const { providers, connection, host, replica, projects, synced } = useRuntime(hostKey)
  const hasWorkspace = useHostStore((s) =>
    Object.values(s.runtimes).some((r) => r.replica.order.length > 0 || r.projects.length > 0),
  )
  const [setupSkipped, setSetupSkipped] = useState(setupWasSkipped)
  const [text, setText] = useState('')
  const [instanceId, setInstanceId] = useState<string>()
  const defaults = usePreferences((s) => hostDefaults(s.hosts, host?.hostId ?? hostKey))
  const [selection, setSelection] = useState<{
    key: string
    modeId?: string
    choice: ModelChoice
  }>()
  const [chosenFolder, setChosenFolder] = useState(initialProject ?? '')
  const [workspace, setWorkspace] = useState<Workspace>({ mode: 'local' })
  const [repo, setRepo] = useState<RepoState | null | 'loading'>('loading')

  const ready = readyProviders(providers)
  const agent =
    ready.find((p) => p.id === instanceId) ?? defaultAgent(providers, defaults.instanceId)
  const saved = agentDefaults(defaults, agent)
  const selectionKey = `${host?.hostId ?? hostKey}:${agent?.id ?? ''}`
  const modeId = selection?.key === selectionKey ? selection.modeId : saved.permissionMode
  const chosen =
    selection?.key === selectionKey
      ? selection.choice
      : { model: saved.model, effort: saved.effort }
  const choice = modelChoice(
    agent?.capabilities.models ?? [],
    agent?.capabilities.efforts ?? [],
    chosen,
  )
  const setModeId = (next: string) => setSelection({ key: selectionKey, modeId: next, choice })
  const setChoice = (next: ModelChoice) => setSelection({ key: selectionKey, modeId, choice: next })

  const folder = chosenFolder || projects[0]?.path || host?.defaultCwd || ''

  // Look at the folder's repository whenever it changes: branches for the picker, and whether
  // worktrees are possible at all.
  useEffect(() => {
    if (!folder || connection !== 'connected') return
    let cancelled = false
    setRepo('loading')
    Promise.all([
      hostRequest(hostKey, 'git.info', { cwd: folder }),
      hostRequest(hostKey, 'git.branches', { cwd: folder }),
    ])
      .then(([info, branches]) => {
        if (cancelled) return
        setRepo(info.isRepo ? { info, branches } : null)
        // Isolated worktrees are the default whenever there is a commit to branch from.
        setWorkspace(
          defaultWorkspace === 'worktree' &&
            info.isRepo &&
            info.defaultBranch &&
            branches.length > 0
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
  }, [hostKey, folder, connection, defaultWorkspace])

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
    const useWorktree = repo && repo !== 'loading' && workspace.mode === 'worktree'
    const sessionId = await createSession(hostKey, {
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

  if (!initialProject && synced && !hasWorkspace && !setupSkipped)
    return (
      <Welcome
        hostKey={hostKey}
        onAddFolder={async (path) => {
          const added = await addProject(hostKey, path)
          setChosenFolder(added.path)
        }}
        onSkip={() => {
          skipSetup()
          setSetupSkipped(true)
        }}
      />
    )

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
          hostKey={hostKey}
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
                  const added = await addProject(hostKey, p)
                  setChosenFolder(added.path)
                }}
              />
              <HostChip
                hostKey={hostKey}
                onPick={(key) => {
                  setHostKey(key)
                  setChosenFolder('')
                  setInstanceId(undefined)
                }}
              />
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
            {QUICK_STARTS.map(({ icon: Icon, label, prompt: starter }) => (
              <button key={label} onClick={() => setText(starter)}>
                <Icon size={18} /> {label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </main>
  )
}

/** Which host the session runs on. A plain label while this computer is the only host. */
function HostChip({ hostKey, onPick }: { hostKey: string; onPick(key: string): void }) {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const current = entries.find((e) => e.key === hostKey)
  const name =
    hostKey === LOCAL_HOST_KEY
      ? 'This PC'
      : (runtimes[hostKey]?.host?.name ?? current?.name ?? 'Host')
  if (entries.length < 2) {
    return (
      <span className="chip-lite static">
        <Monitor size={14} /> {name}
      </span>
    )
  }
  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button className="chip-lite" onClick={toggle} aria-label="Host">
          {hostKey === LOCAL_HOST_KEY ? <Monitor size={14} /> : <Server size={14} />} {name}{' '}
          <ChevronDown size={13} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-heading">Run on</div>
          {entries.map((e) => {
            const r = runtimes[e.key]
            const online = r?.connection === 'connected'
            return (
              <button
                key={e.key}
                className="menu-row"
                disabled={!online}
                aria-checked={e.key === hostKey}
                onClick={() => {
                  onPick(e.key)
                  close()
                }}
              >
                <span className="menu-text">
                  <span className="menu-title">{r?.host?.name ?? e.name}</span>
                  {!online && <span className="menu-desc">Offline</span>}
                </span>
                {e.key === hostKey ? (
                  <Check size={16} />
                ) : (
                  <span className={`dot ${online ? 'ok' : 'warn'}`} />
                )}
              </button>
            )
          })}
        </>
      )}
    </Dropdown>
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
