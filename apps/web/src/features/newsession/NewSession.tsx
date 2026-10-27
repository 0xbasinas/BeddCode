import {} from '../../ui/AgentMark.tsx'
import { AgentMark } from '../../ui/AgentMark.tsx'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  Bot,
  Check,
  ChevronDown,
  Folder,
  FolderPlus,
  GitBranch,
  Globe,
  PenTool,
  MessageSquare,
  Monitor,
  Server,
} from 'lucide-react'
import type {
  AgentPreview,
  GitBranch as Branch,
  GitInfo,
  ProviderInstance,
  SlashCommand,
} from '@beddcode/contracts'
import { ConfigMenu } from '../composer/ConfigMenu.tsx'
import { Composer } from '../composer/Composer.tsx'
import { ModelMenu, type ModelChoice } from '../composer/Menus.tsx'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { folderName, timeAgo } from '../../ui/format.ts'
import {
  createSession,
  hostRequest,
  prompt,
  readyProviders,
  useHostStore,
  useRuntime,
} from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { clearHandoff, peekHandoff } from '../../stores/handoff.ts'
import { Welcome, setupWasSkipped, skipSetup } from './Welcome.tsx'
import { showWelcome } from './welcomeLogic.ts'
import { chooseFolder } from '../folders/folderFlow.ts'
import { useAppPreferences } from '../../stores/appPreferences.ts'
import { modelChoice } from '../../ui/models.ts'
import { projectDraftId, useComposerWorkspace } from '../../stores/composerWorkspace.ts'
import { composerDraftKey, useComposerDrafts } from '../composer/drafts.ts'
import {
  agentDefaults,
  defaultAgent,
  hostDefaults,
  usePreferences,
} from '../../stores/preferences.ts'

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
  compose,
}: {
  initialProject?: string
  initialHost?: string
  /** Show the composer straight away, even on a first run (the sidebar's New session). */
  compose?: boolean
}) {
  const navigate = useNavigate()
  const entries = useHostStore((s) => s.entries)
  const defaultHostKey = useAppPreferences((s) => s.values.defaultHostKey)
  const defaultWorkspace = useAppPreferences((s) => s.values.defaultWorkspace)
  const resumeDraft = initialHost === undefined && initialProject === undefined
  const savedDestination = useComposerDrafts.getState().lastNewSession
  const [hostKey, setHostKey] = useState(() => {
    const preferred =
      initialHost ?? (resumeDraft ? savedDestination?.hostKey : undefined) ?? defaultHostKey
    return entries.some((e) => e.key === preferred) ? preferred : LOCAL_HOST_KEY
  })
  const { providers, connection, host, replica, projects, synced, loadError } = useRuntime(hostKey)
  // The welcome checklist stays up until the first session, so adding a folder never jumps
  // straight into a composer; its last step starts the session.
  const hasSessions = useHostStore((s) =>
    Object.values(s.runtimes).some((r) => r.replica.order.length > 0),
  )
  const [setupSkipped, setSetupSkipped] = useState(setupWasSkipped)
  const [instanceId, setInstanceId] = useState<string>()
  const defaults = usePreferences((s) => hostDefaults(s.hosts, host?.hostId ?? hostKey))
  const [selection, setSelection] = useState<{
    key: string
    modeId?: string
    choice: ModelChoice
  }>()
  const [chosenFolder, setChosenFolder] = useState(
    () =>
      initialProject ??
      (resumeDraft && savedDestination?.hostKey === hostKey ? savedDestination.folder : ''),
  )
  const [workspace, setWorkspace] = useState<Workspace>({ mode: 'local' })
  const [agentTools, setAgentTools] = useState(false)
  const [browserTools, setBrowserTools] = useState(false)
  const [designTools, setDesignTools] = useState(false)
  const [repo, setRepo] = useState<RepoState | null | 'loading'>('loading')
  const [commands, setCommands] = useState<SlashCommand[]>([])
  const [preview, setPreview] = useState<{ key: string; data?: AgentPreview; failed?: boolean }>()
  const [configState, setConfigState] = useState<{
    key: string
    values: Record<string, string | boolean>
  }>()

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

  const folder = chosenFolder
  const welcome = showWelcome({ initialProject, compose, synced, hasSessions, setupSkipped })
  const draftId = projectDraftId(folder)
  const memoryKey = composerDraftKey(hostKey, draftId)
  const text = useComposerDrafts((s) => s.drafts[memoryKey] ?? '')
  const setText = useCallback(
    (value: string) => useComposerDrafts.getState().setDraft(memoryKey, value),
    [memoryKey],
  )
  const activeDraft = useRef<string | undefined>(memoryKey)
  useLayoutEffect(() => {
    activeDraft.current = memoryKey
    // An explicit handoff supplies the starting message once; returning restores the edited draft.
    const handoff = peekHandoff(hostKey)
    if (handoff !== undefined) {
      useComposerDrafts.getState().setDraft(memoryKey, handoff)
      clearHandoff()
    }
    return () => {
      activeDraft.current = undefined
    }
  }, [hostKey, memoryKey])
  useEffect(() => {
    useComposerDrafts.getState().rememberNewSession({ hostKey, folder })
  }, [hostKey, folder])

  useEffect(() => {
    useComposerWorkspace.setState({
      workspace:
        !welcome && folder
          ? {
              hostKey,
              cwd: folder,
              draftId,
              title: folderName(folder),
              instanceId: agent?.id,
              projectPath: folder,
            }
          : undefined,
    })
    return () => useComposerWorkspace.setState({ workspace: undefined })
  }, [hostKey, folder, draftId, agent?.id, welcome])

  // Look at the folder's repository whenever it changes: branches for the picker, and whether
  // worktrees are possible at all.
  useEffect(() => {
    setRepo(null)
    setWorkspace({ mode: 'local' })
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

  // The agent's slash commands and skills for this folder, so `/` works before the session exists.
  useEffect(() => {
    setCommands([])
    if (!agent?.capabilities.commands || connection !== 'connected') return
    let cancelled = false
    hostRequest(hostKey, 'commands.list', { instanceId: agent.id, cwd: folder || undefined }).then(
      (list) => !cancelled && setCommands(list),
      () => {},
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, agent?.id, agent?.capabilities.commands, folder, connection])

  // ACP agents only say what they offer (modes, model, thinking level, commands) when a session
  // starts, so the host probes once and remembers it. Without this their composer would be bare.
  const previewKey = `${hostKey}:${agent?.id ?? ''}`
  useEffect(() => {
    if (!agent || agent.kind !== 'acp' || connection !== 'connected') return
    let cancelled = false
    setPreview({ key: previewKey })
    hostRequest(hostKey, 'agents.preview', { instanceId: agent.id, cwd: folder || undefined }).then(
      (data) => !cancelled && setPreview({ key: previewKey, data }),
      () => !cancelled && setPreview({ key: previewKey, failed: true }),
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, agent?.id, agent?.kind, folder, connection, previewKey])
  const agentPreview = preview?.key === previewKey ? preview : undefined
  const offered = agentPreview?.data
  const loadingOffer =
    agent?.kind === 'acp' && agentPreview !== undefined && !offered && !agentPreview.failed

  const configValues = configState?.key === selectionKey ? configState.values : {}
  const configOptions = (offered?.config ?? []).map((o) => ({
    ...o,
    value: configValues[o.id] ?? o.value,
  }))

  const nativeModes = agent?.capabilities.permissionModes ?? []
  const modes = nativeModes.length > 0 ? nativeModes : (offered?.modes ?? [])
  // A remembered choice from another agent may not exist here; then the agent's own current mode
  // (what it starts in) is what is shown and what applies.
  const validModeId = modes.some((m) => m.id === modeId) ? modeId : undefined
  const shownModeId = validModeId ?? offered?.currentModeId
  const slashCommands = commands.length > 0 ? commands : (offered?.commands ?? [])
  const recentFolders = useMemo(
    () =>
      [
        ...new Set([
          ...projects.map((p) => p.path),
          ...replica.order.flatMap((id) => {
            const session = replica.sessions[id]!
            return session.projectless ? [] : [session.projectPath]
          }),
        ]),
      ].slice(0, 8),
    [replica, projects],
  )

  const send = async (value: string, attachments: string[]) => {
    if (!agent) throw new Error('No agent is ready on this host')
    const useWorktree = folder && repo && repo !== 'loading' && workspace.mode === 'worktree'
    try {
      const sessionId = await createSession(hostKey, {
        instanceId: agent.id,
        cwd: folder || undefined,
        projectless: !folder || undefined,
        permissionMode: validModeId,
        model: choice.model,
        effort: choice.effort,
        config: Object.keys(configValues).length > 0 ? configValues : undefined,
        workspace: useWorktree ? { mode: 'worktree', baseBranch: workspace.baseBranch } : undefined,
        agentTools: agentTools || undefined,
        browserTools: browserTools || undefined,
        designTools: designTools || undefined,
      })
      await prompt(sessionId, value, attachments)
      if (activeDraft.current === memoryKey)
        void navigate({ to: '/session/$sessionId', params: { sessionId } })
    } catch (err) {
      useComposerDrafts.getState().restoreDraft(memoryKey, text)
      throw err
    }
  }

  if (welcome)
    return (
      <Welcome
        hostKey={hostKey}
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
        <div className="thread-meta">The agent starts when you send</div>
      </header>
      <div className="new-body">
        <h2>{agent ? `What should ${agent.label} work on?` : 'What should we work on?'}</h2>
        <p>
          {connection !== 'connected'
            ? 'Connecting to your host…'
            : agent
              ? 'Describe a task, paste an issue link, or ask a question.'
              : loadError && providers.length === 0
                ? `${loadError}. Trying again…`
                : 'No agent is ready on this host yet. Install and sign in to Claude Code or Codex, or add an ACP agent.'}
        </p>
        <Composer
          text={text}
          onTextChange={setText}
          placeholder="Describe a task, or paste an issue link…"
          busy={false}
          disabled={connection !== 'connected' || !agent || (!!folder && repo === 'loading')}
          disabledReason={
            connection !== 'connected'
              ? 'the host is connected'
              : !agent
                ? loadError && providers.length === 0
                  ? 'the host lists its agents'
                  : 'an agent is ready'
                : 'the folder is read'
          }
          autoFocus
          hostKey={hostKey}
          draftId={draftId}
          commands={slashCommands}
          onSend={send}
          modes={modes}
          modeId={shownModeId}
          onModeChange={setModeId}
          modelSlot={
            agent && (
              <>
                {loadingOffer && <span className="muted offer-note">Reading settings…</span>}
                <ConfigMenu
                  agent={agent.id}
                  options={configOptions}
                  onChange={(id, value) =>
                    setConfigState({
                      key: selectionKey,
                      values: { ...configValues, [id]: value },
                    })
                  }
                />
                <ModelMenu
                  agent={agent.id}
                  models={agent.capabilities.models ?? []}
                  efforts={agent.capabilities.efforts ?? []}
                  value={choice}
                  onChange={setChoice}
                />
              </>
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
                onAdd={async () => {
                  const added = await chooseFolder(hostKey)
                  if (added) setChosenFolder(added.path)
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
              <div className="capability-toggles" role="group" aria-label="Agent capabilities">
                <button
                  className="capability-toggle"
                  aria-label="Start other agents"
                  aria-pressed={agentTools}
                  title={`Start other agents: ${agentTools ? 'on' : 'off'}. Approvals still come to you.`}
                  onClick={() => setAgentTools((v) => !v)}
                >
                  <Bot size={15} aria-hidden="true" />
                </button>
                <button
                  className="capability-toggle"
                  aria-label="Use browser"
                  aria-pressed={browserTools}
                  title={`Use browser: ${browserTools ? 'on' : 'off'}. Let the agent use browser tabs in the desktop app.`}
                  onClick={() => setBrowserTools((v) => !v)}
                >
                  <Globe size={15} aria-hidden="true" />
                </button>
                <button
                  className="capability-toggle"
                  aria-label="Design canvases"
                  aria-pressed={designTools}
                  title={`Design canvases: ${designTools ? 'on' : 'off'}. Let the agent read and edit designs.`}
                  onClick={() => setDesignTools((v) => !v)}
                >
                  <PenTool size={15} aria-hidden="true" />
                </button>
              </div>
              {repo && repo !== 'loading' && (
                <WorkspaceChip repo={repo} workspace={workspace} onChange={setWorkspace} />
              )}
            </div>
          }
        />
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
        <Monitor size={14} /> <span className="chip-text">{name}</span>
      </span>
    )
  }
  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button className="chip-lite" onClick={toggle} aria-label="Host">
          {hostKey === LOCAL_HOST_KEY ? <Monitor size={14} /> : <Server size={14} />}{' '}
          <span className="chip-text">{name}</span> <ChevronDown size={13} />
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

export function AgentChip({
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
          <AgentMark agent={current?.id} label={current?.label ?? '–'} />
          <span className="chip-text">{current?.label ?? 'No agent'}</span>{' '}
          <ChevronDown size={13} />
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
              <AgentMark agent={a.id} label={a.label} />
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
  /** Opens the Add folder flow (system picker or folder browser); nothing is typed. */
  onAdd(): Promise<void>
}) {
  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button
          className="chip-lite"
          onClick={toggle}
          aria-label="Folder"
          title={value || 'Start without a project folder'}
        >
          {value ? <Folder size={14} /> : <MessageSquare size={14} />}{' '}
          <span className="chip-text">{value ? folderName(value) : 'No project'}</span>{' '}
          <ChevronDown size={13} />
        </button>
      )}
      panelClassName="wide"
    >
      {(close) => (
        <>
          <button
            className="menu-row"
            aria-checked={!value}
            onClick={() => {
              onChange('')
              close()
            }}
          >
            <MessageSquare size={15} />
            <span className="menu-text">
              <span className="menu-title">No project</span>
              <span className="menu-desc">Start a session without a project folder</span>
            </span>
            {!value && <Check size={16} />}
          </button>
          <div className="menu-sep" />
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
          {recent.length > 0 && <div className="menu-sep" />}
          <button
            className="menu-row"
            onClick={() => {
              close()
              void onAdd()
            }}
          >
            <FolderPlus size={15} />
            <span className="menu-text">Add folder…</span>
          </button>
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
          <GitBranch size={14} /> <span className="chip-text">{label}</span>{' '}
          <ChevronDown size={13} />
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
