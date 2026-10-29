import {} from '../../ui/AgentMark.tsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
  Maximize2,
  X,
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
import { endedByDecline, handoffPrompt } from '@beddcode/client-runtime'
import { setHandoff } from '../../stores/handoff.ts'
import { useFollowEnd } from './useFollowEnd.ts'
import { MessageNav } from './MessageNav.tsx'
import { folderId, useFiles } from '../files/filesStore.ts'
import { useUiStore } from '../../stores/ui.ts'
import { EnvironmentButton, SessionChip } from './SessionPanel.tsx'
import { RenameSessionDialog } from './RenameSessionDialog.tsx'
import { threadKey } from './threadState.ts'
import { useComposerDrafts } from '../composer/drafts.ts'
import { usePane, type PaneInfo } from '../split/paneContext.ts'

export function ThreadView({ sessionId }: { sessionId: string }) {
  const navigate = useNavigate()
  const session = useSession(sessionId)
  // Shown beside other sessions: the keyboard and the browser go to the pane last used.
  const pane = usePane()
  const paneActive = pane?.active ?? true
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
  const memoryKey = threadKey(hostKey, sessionId)
  const text = useComposerDrafts((s) => s.drafts[memoryKey] ?? '')
  const setText = useCallback(
    (value: string) => useComposerDrafts.getState().setDraft(memoryKey, value),
    [memoryKey],
  )
  const [renaming, setRenaming] = useState(false)
  const [actionError, setActionError] = useState<string>()
  const scroller = useRef<HTMLDivElement>(null)
  const followEnd = useFollowEnd(scroller, session?.items, memoryKey)
  const [jump, setJump] = useState<{ id: string; n: number }>()
  const jumpToMessage = useCallback(
    (id: string) => setJump((j) => ({ id, n: (j?.n ?? 0) + 1 })),
    [],
  )
  useEffect(() => {
    if (!jump) return
    const node = scroller.current?.querySelector(`[data-msg-id="${CSS.escape(jump.id)}"]`)
    node?.scrollIntoView({ block: 'start', behavior: 'smooth' })
  }, [jump])

  // The agent's browser tool calls go to the window showing its session.
  useEffect(() => {
    if (!paneActive) return
    const report = () => reportShownSession(hostKey, sessionId)
    report()
    window.addEventListener('focus', report)
    return () => window.removeEventListener('focus', report)
  }, [hostKey, sessionId, paneActive])

  const pending = useMemo(
    () =>
      session?.items.findLast((i) => i.kind === 'approval' && !i.resolvedOptionId && !i.cancelled),
    [session?.items],
  )
  const stats = useMemo(
    () => ({ added: session?.added ?? 0, removed: session?.removed ?? 0 }),
    [session?.added, session?.removed],
  )
  const busy = session?.status === 'running' || session?.status === 'needs-you'
  const changes = useMemo(
    () => ({ hostKey, sessionId, idle: !busy, worktree: Boolean(session?.worktree) }),
    [hostKey, sessionId, busy, session?.worktree],
  )
  const cwd = session?.cwd
  const openFile = useCallback(
    (path: string) => {
      if (!cwd) return
      useUiStore.getState().openPane('files')
      void useFiles.getState().open(folderId(hostKey, cwd), path)
    },
    [hostKey, cwd],
  )
  const approveRequest = useCallback(
    (requestId: string, optionId: string) => approve(sessionId, requestId, optionId),
    [sessionId],
  )
  const answerRequest = useCallback(
    (requestId: string, answers?: Record<string, string[]>) =>
      answerQuestion(sessionId, requestId, answers),
    [sessionId],
  )
  const fork = useCallback(
    async (throughTurn?: number) => {
      setActionError(undefined)
      try {
        const forked = await forkSession(sessionId, throughTurn)
        void navigate({ to: '/session/$sessionId', params: { sessionId: forked } })
      } catch (err) {
        setActionError(err instanceof Error ? err.message : String(err))
      }
    },
    [navigate, sessionId],
  )

  // Enter allows and Escape denies the open request, unless the user is typing somewhere.
  useEffect(() => {
    if (pending?.kind !== 'approval' || !paneActive) return
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
  }, [pending, sessionId, paneActive])

  if (!session) {
    return (
      <main className="panel thread-empty">
        {loading
          ? 'Loading…'
          : hostAway
            ? 'Session not found. It may be on a host that is offline.'
            : 'Session not found'}
        {pane && (
          <div className="thread-empty-actions">
            <PaneButtons pane={pane} />
          </div>
        )}
      </main>
    )
  }

  const provider = providers.find((p) => p.id === session.instanceId)
  const modes = session.modes ?? provider?.capabilities.permissionModes ?? []
  const canSteer = provider?.capabilities.steer === true
  // Forking needs the agent's own conversation id, which exists once the first turn has begun.
  const canFork = provider?.capabilities.fork === true && session.completedTurns > 0

  const report = (err: unknown) => setActionError(err instanceof Error ? err.message : String(err))

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
          {pane && <PaneButtons pane={pane} />}
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
            live={session.status === 'running'}
            items={session.items}
            cwd={session.cwd}
            sessionId={sessionId}
            hostKey={hostKey}
            readingKey={memoryKey}
            onOpenFile={openFile}
            onApprove={approveRequest}
            onAnswer={answerRequest}
            onFork={canFork ? fork : undefined}
            jumpTo={jump}
            completedTurns={session.completedTurns}
            stoppedTurn={
              session.lastTurnReason === 'cancelled' ? session.completedTurns : undefined
            }
            changes={changes}
          />
        </div>
      </div>
      <MessageNav items={session.items} scroller={scroller} onJump={jumpToMessage} />
      {actionError && (
        <p className="thread-action-error" role="alert">
          {actionError}
        </p>
      )}
      <Composer
        key={sessionId}
        draftId={sessionId}
        cwd={session.cwd}
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
          followEnd()
          try {
            await prompt(sessionId, value, attachments)
          } catch (err) {
            useComposerDrafts.getState().restoreDraft(memoryKey, text)
            throw err
          }
        }}
        modes={modes}
        modeId={session.currentModeId}
        onModeChange={(id) => void setMode(sessionId, id)}
        modelSlot={
          session.config.length > 0 ? (
            <ConfigMenu
              agent={session.instanceId}
              options={session.config}
              onChange={(id, value) => setConfigOption(sessionId, id, value).catch(report)}
            />
          ) : (provider?.capabilities.models?.length ?? 0) > 0 ? (
            // Claude and Codex take a different model from the next message on.
            <ModelMenu
              agent={session.instanceId}
              models={provider?.capabilities.models ?? []}
              efforts={provider?.capabilities.efforts ?? []}
              value={{ model: session.model, effort: session.effort }}
              onChange={(choice) =>
                void setSessionModel(sessionId, choice.model, choice.effort).catch(report)
              }
            />
          ) : (
            <ModelBadge
              agent={session.instanceId}
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

/** A pane in a split: show its session alone, or close the pane. */
function PaneButtons({ pane }: { pane: PaneInfo }) {
  return (
    <>
      <button
        className="icon-btn"
        aria-label="Show alone"
        title="Show this session alone"
        onClick={pane.solo}
      >
        <Maximize2 size={15} />
      </button>
      <button
        className="icon-btn"
        aria-label="Close pane"
        title="Close this pane (the session keeps running)"
        onClick={pane.close}
      >
        <X size={17} />
      </button>
    </>
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
