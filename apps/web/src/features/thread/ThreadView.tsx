import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import {
  Copy,
  Folder,
  GitBranch,
  GitFork,
  MoreHorizontal,
  Plus,
  Server,
  Trash2,
  Pencil,
  Pin,
  PinOff,
  ArrowRightLeft,
  GitPullRequest,
} from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import { Composer } from '../composer/Composer.tsx'
import { ModelBadge, ModelMenu } from '../composer/Menus.tsx'
import { ConfigMenu } from '../composer/ConfigMenu.tsx'
import { PlanCard } from './PlanCard.tsx'
import { QueueList } from './QueueList.tsx'
import { Dropdown } from '../../ui/Dropdown.tsx'
import {
  answerQuestion,
  approve,
  dequeue,
  forkSession,
  setSessionModel,
  setSessionPinned,
  hostRequest,
  interrupt,
  setConfigOption,
  prompt,
  reportShownSession,
  setMode,
  useHostStore,
  useRuntime,
  useSession,
  useSessionHostKey,
} from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { folderName } from '../../ui/format.ts'
import { Transcript } from './Transcript.tsx'
import { ChildAgentsBar, StartedByBanner } from './AgentToolCard.tsx'
import { endedByDecline, handoffPrompt, sessionChanges } from '@beddcode/client-runtime'
import { setHandoff } from '../../stores/handoff.ts'
import { useFollowEnd } from './useFollowEnd.ts'
import { MessageNav } from './MessageNav.tsx'
import { folderId, useFiles } from '../files/filesStore.ts'
import { useUiStore } from '../../stores/ui.ts'
import { EnvironmentButton, SessionChip } from './SessionPanel.tsx'
import { RenameSessionDialog } from './RenameSessionDialog.tsx'

export function ThreadView({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate()
  const session = useSession(sessionId)
  const hostKey = useSessionHostKey(sessionId) ?? LOCAL_HOST_KEY
  const { providers, host } = useRuntime(hostKey)
  const multiHost = useHostStore((s) => s.entries.length > 1)
  const hostName = multiHost ? (host?.name ?? hostKey) : undefined
  // Still waiting on a host that has not replied yet, or one that is away.
  const loading = useHostStore((s) =>
    Object.values(s.runtimes).some(
      (r) => r.connection === 'connecting' || (r.connection === 'connected' && !r.synced),
    ),
  )
  const hostAway = useHostStore((s) =>
    Object.values(s.runtimes).some((r) => r.connection !== 'connected'),
  )
  const [text, setText] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const scroller = useRef<HTMLDivElement>(null)
  useFollowEnd(scroller, session?.items)
  const [jump, setJump] = useState<{ id: string; n: number }>()
  useEffect(() => {
    if (!jump) return
    const node = scroller.current?.querySelector(`[data-msg-id="${CSS.escape(jump.id)}"]`)
    node?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [jump])

  // The agent's browser tool calls go to the window showing its session.
  useEffect(() => {
    const report = () => reportShownSession(hostKey, sessionId)
    report()
    window.addEventListener('focus', report)
    return () => window.removeEventListener('focus', report)
  }, [hostKey, sessionId])

  const pending = useMemo(
    () =>
      session?.items.findLast((i) => i.kind === 'approval' && !i.resolvedOptionId && !i.cancelled),
    [session?.items],
  )

  // Enter allows and Escape denies the open request, unless the user is typing somewhere.
  useEffect(() => {
    if (pending?.kind !== 'approval') return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, textarea, [contenteditable], button, [role="menu"]')) return
      const pick = (kind: 'allow' | 'deny') => pending.options.find((o) => o.kind === kind)
      const option =
        e.key === 'Enter' ? pick('allow') : e.key === 'Escape' ? pick('deny') : undefined
      if (!option) return
      e.preventDefault()
      document.getElementById(`approval-${pending.id}-${option.id}`)?.click()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending, sessionId])

  if (!session) {
    return (
      <main className="panel thread-empty">
        {loading
          ? 'Loading…'
          : hostAway
            ? 'Session not found. It may be on a host that is offline.'
            : 'Session not found'}
      </main>
    )
  }

  const provider = providers.find((p) => p.id === session.instanceId)
  const busy = session.status === 'running' || session.status === 'needs-you'
  const modes = session.modes ?? provider?.capabilities.permissionModes ?? []
  const canSteer = provider?.capabilities.steer === true
  // Forking needs the agent's own conversation id, which exists once the first turn has begun.
  const canFork = provider?.capabilities.fork === true && session.completedTurns > 0

  const fork = async (throughTurn?: number) => {
    setActionError(undefined)
    try {
      const forked = await forkSession(sessionId, throughTurn)
      void navigate({ to: '/session/$sessionId', params: { sessionId: forked } })
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    }
  }
  const report = (err: unknown) => setActionError(err instanceof Error ? err.message : String(err))
  const stats = sessionChanges(session.items)

  return (
    <main className="panel thread">
      <header className="thread-head">
        <div className="thread-heading">
          <h1 title={session.title}>{session.title}</h1>
          <div className="thread-meta" title={session.cwd}>
            {hostKey === LOCAL_HOST_KEY ? 'This PC' : (host?.name ?? hostKey)} ·{' '}
            {session.projectless ? 'No project' : folderName(session.projectPath)}
            {session.branch ? ` · ${session.branch}` : ''}
            {session.context && session.context.size > 0 && (
              <span
                title={`${session.context.used.toLocaleString()} of ${session.context.size.toLocaleString()} tokens of the agent's context window`}
              >
                {' · '}
                Context{' '}
                {Math.min(100, Math.round((session.context.used / session.context.size) * 100))}%
              </span>
            )}
            {session.forkedFrom && (
              <>
                {' · '}
                <Link
                  to="/session/$sessionId"
                  params={{ sessionId: session.forkedFrom.sessionId }}
                  className="thread-fork-link"
                >
                  Forked from {session.forkedFrom.title ?? 'another session'}
                </Link>
              </>
            )}
            {session.imported ? ' · Imported' : ''}
          </div>
        </div>
        <div className="thread-actions">
          <EnvironmentButton session={session} hostKey={hostKey} stats={stats} />
          <Dropdown
            placement="bottom"
            align="end"
            trigger={({ toggle, open }) => (
              <button
                className="icon-btn"
                aria-label="Session menu"
                aria-expanded={open}
                onClick={toggle}
              >
                <MoreHorizontal size={18} />
              </button>
            )}
          >
            {(close) => (
              <>
                <button
                  className="menu-row"
                  onClick={() => {
                    close()
                    setRenaming(true)
                  }}
                >
                  <Pencil size={15} /> Rename session
                </button>
                <button
                  className="menu-row"
                  onClick={() => {
                    close()
                    void navigate({
                      to: '/',
                      search: session.projectless
                        ? { host: hostKey, compose: true }
                        : { host: hostKey, project: session.projectPath },
                    })
                  }}
                >
                  <Plus size={15} />
                  {session.projectless
                    ? 'New session without a project'
                    : 'New session in this folder'}
                </button>
                <button
                  className="menu-row"
                  onClick={() => {
                    close()
                    void setSessionPinned(sessionId, !session.pinned)
                  }}
                >
                  {session.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                  {session.pinned ? 'Unpin' : 'Pin to top'}
                </button>
                <button
                  className="menu-row"
                  title="Start a new session with a summary of this one, so another agent can pick it up"
                  onClick={() => {
                    close()
                    setHandoff(hostKey, handoffPrompt(session, { agentLabel: provider?.label }))
                    void navigate({
                      to: '/',
                      search: session.projectless
                        ? { host: hostKey, compose: true }
                        : { host: hostKey, project: session.projectPath },
                    })
                  }}
                >
                  <ArrowRightLeft size={15} />
                  Continue with another agent
                </button>
                {canFork && (
                  <button
                    className="menu-row"
                    onClick={() => {
                      close()
                      void fork()
                    }}
                  >
                    <GitFork size={15} />
                    Fork this session
                  </button>
                )}
                <button
                  className="menu-row"
                  onClick={() => {
                    void navigator.clipboard?.writeText(session.cwd)
                    close()
                  }}
                >
                  <Copy size={15} />
                  {session.projectless ? 'Copy session files path' : 'Copy folder path'}
                </button>
                <button
                  className="menu-row"
                  onClick={() => {
                    void navigator.clipboard?.writeText(window.location.href)
                    close()
                  }}
                >
                  <Copy size={15} />
                  Copy session link
                </button>
              </>
            )}
          </Dropdown>
        </div>
      </header>
      <div className="transcript" ref={scroller}>
        <div className="transcript-inner">
          <div className="session-start">
            Started{' '}
            {new Date(session.createdAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
            {session.worktree ? ` · worktree from ${session.worktree.baseBranch}` : ''}
          </div>
          {session.parent && <StartedByBanner session={session} hostKey={hostKey} />}
          <Transcript
            items={session.items}
            cwd={session.cwd}
            sessionId={sessionId}
            hostKey={hostKey}
            onOpenFile={(path) => {
              useUiStore.getState().openPane('files')
              void useFiles.getState().open(folderId(hostKey, session.cwd), path)
            }}
            onApprove={(requestId, optionId) => approve(sessionId, requestId, optionId)}
            onAnswer={(requestId, answers) => answerQuestion(sessionId, requestId, answers)}
            onFork={canFork ? (turnNo) => fork(turnNo) : undefined}
            jumpTo={jump}
            completedTurns={session.completedTurns}
            stoppedTurn={
              session.lastTurnReason === 'cancelled' ? session.completedTurns : undefined
            }
            changes={{ hostKey, sessionId, idle: !busy, worktree: Boolean(session?.worktree) }}
          />
        </div>
      </div>
      <MessageNav
        items={session.items}
        scroller={scroller}
        onJump={(id) => setJump((j) => ({ id, n: (j?.n ?? 0) + 1 }))}
      />
      {actionError && (
        <p className="thread-action-error" role="alert">
          {actionError}
        </p>
      )}
      <Composer
        key={sessionId}
        draftId={sessionId}
        text={text}
        onTextChange={setText}
        placeholder={
          session.items.length === 0
            ? 'Describe a task…'
            : busy
              ? canSteer
                ? 'Steer the agent, or queue a message…'
                : 'Queue a message for when this turn ends…'
              : endedByDecline(session)
                ? `You declined. Tell ${provider?.label ?? 'the agent'} what to do instead…`
                : `Reply to ${provider?.label ?? 'the agent'}…`
        }
        focusSignal={endedByDecline(session) ? session.completedTurns : undefined}
        commands={session.commands}
        above={
          <>
            {session.agentTools && <ChildAgentsBar sessionId={sessionId} hostKey={hostKey} />}
            {session.plan && <PlanCard plan={session.plan} />}
            <QueueList
              queue={session.queue}
              busy={busy}
              canSteer={canSteer}
              onSend={(queueId) => void dequeue(sessionId, queueId, 'steer').catch(report)}
              onCancel={(queueId) => void dequeue(sessionId, queueId, 'cancel').catch(report)}
            />
          </>
        }
        busy={busy}
        onStop={() => {
          setActionError(undefined)
          void interrupt(sessionId).catch((err: unknown) =>
            setActionError(err instanceof Error ? err.message : String(err)),
          )
        }}
        onSend={async (value, attachments) => {
          await prompt(sessionId, value, attachments)
        }}
        modes={modes}
        modeId={session.currentModeId}
        onModeChange={(id) => void setMode(sessionId, id)}
        modelSlot={
          session.config.length > 0 ? (
            <ConfigMenu
              options={session.config}
              onChange={(id, value) => setConfigOption(sessionId, id, value).catch(report)}
            />
          ) : (provider?.capabilities.models?.length ?? 0) > 0 ? (
            // Claude and Codex take a different model from the next message on.
            <ModelMenu
              models={provider?.capabilities.models ?? []}
              efforts={provider?.capabilities.efforts ?? []}
              value={{ model: session.model, effort: session.effort }}
              onChange={(choice) =>
                void setSessionModel(sessionId, choice.model, choice.effort).catch(report)
              }
            />
          ) : (
            <ModelBadge
              models={provider?.capabilities.models ?? []}
              model={session.model}
              effort={session.effort}
            />
          )
        }
        hostKey={hostKey}
        footer={
          <SessionFooter
            session={session}
            hostKey={hostKey}
            hostName={hostName}
            agent={provider?.label}
            stats={stats}
          />
        }
      />
      {renaming && (
        <RenameSessionDialog
          session={session}
          hostKey={hostKey}
          onClose={() => setRenaming(false)}
        />
      )}
    </main>
  )
}

function SessionFooter({
  session,
  hostKey,
  hostName,
  agent,
  stats,
}: {
  session: SessionView
  hostKey: string
  /** Shown only when more than one host is in use. */
  hostName: string | undefined
  agent: string | undefined
  stats: { added: number; removed: number }
}) {
  return (
    <div className="footer-bar">
      <SessionChip agent={agent ?? session.instanceId} />
      {hostName && (
        <span className="chip-lite static" title="The host this session runs on">
          <Server size={14} /> {hostName}
        </span>
      )}
      <span className="sep" />
      {session.worktree ? (
        <WorktreeChip session={session} hostKey={hostKey} />
      ) : (
        <span className="chip-lite" title={session.cwd}>
          <Folder size={14} />{' '}
          {session.projectless ? 'No project' : folderName(session.projectPath)}
        </span>
      )}
      <span className="spacer" />
      {session.branch && (
        <span className="chip-lite static" title={session.branch}>
          <GitBranch size={14} /> <code>{session.branch}</code>
        </span>
      )}
      {(stats.added > 0 || stats.removed > 0) && (
        <span className="stat">
          <span className="add">+{stats.added}</span> <span className="del">−{stats.removed}</span>
        </span>
      )}
    </div>
  )
}

/** The isolated worktree this session works in: where it is, and a way to delete it. */
function WorktreeChip({ session, hostKey }: { session: SessionView; hostKey: string }) {
  const navigate = useNavigate()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)

  const remove = async (close: () => void) => {
    if (!window.confirm('Delete this worktree? The branch and its commits are kept.')) return
    try {
      await hostRequest(hostKey, 'worktrees.remove', { sessionId: session.id })
      close()
      void navigate({ to: '/' })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button className="chip-lite" onClick={toggle} aria-label="Worktree" title={session.cwd}>
          <Folder size={14} /> <span className="chip-text">Worktree</span>
        </button>
      )}
      panelClassName="wide"
    >
      {(close) => (
        <>
          <div className="menu-heading">Worktree</div>
          <code className="menu-path">{session.cwd}</code>
          <div className="menu-heading muted">Branched from {session.worktree?.baseBranch}</div>
          <div className="menu-sep" />
          <button
            className="menu-row"
            onClick={() => {
              void navigator.clipboard?.writeText(session.cwd)
              setCopied(true)
            }}
          >
            <Copy size={16} />
            <span className="menu-text">
              <span className="menu-title">{copied ? 'Copied' : 'Copy path'}</span>
            </span>
          </button>
          <button
            className="menu-row"
            onClick={() => {
              useUiStore.getState().showCreatePr()
              close()
            }}
          >
            <GitPullRequest size={16} />
            <span className="menu-text">
              <span className="menu-title">Create pull request</span>
            </span>
          </button>
          <div className="menu-sep" />
          <button className="menu-row danger" onClick={() => void remove(close)}>
            <Trash2 size={16} />
            <span className="menu-text">
              <span className="menu-title">Remove worktree</span>
            </span>
          </button>
          {error && <div className="composer-error menu-error">{error}</div>}
        </>
      )}
    </Dropdown>
  )
}
