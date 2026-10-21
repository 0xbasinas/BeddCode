import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Copy, Folder, GitBranch, MoreHorizontal, Plus, Server, Trash2, Pencil } from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import { Composer } from '../composer/Composer.tsx'
import { ModelBadge } from '../composer/Menus.tsx'
import { Dropdown } from '../../ui/Dropdown.tsx'
import {
  approve,
  hostRequest,
  interrupt,
  prompt,
  setMode,
  useHostStore,
  useRuntime,
  useSession,
  useSessionHostKey,
} from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { folderName } from '../../ui/format.ts'
import { Transcript } from './Transcript.tsx'
import { buildBlocks, totalChanges } from './blocks.ts'
import { useFollowEnd } from './useFollowEnd.ts'
import { folderId, useFiles } from '../files/filesStore.ts'
import { useUiStore } from '../../stores/ui.ts'
import { SessionPanel } from './SessionPanel.tsx'
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
  const stats = totalChanges(
    buildBlocks(session.items).flatMap((b) => (b.kind === 'edits' ? b.files : [])),
  )

  return (
    <main className="panel thread">
      <header className="thread-head">
        <div className="thread-heading">
          <h1>{session.title}</h1>
          <div className="thread-meta" title={session.cwd}>
            {hostKey === LOCAL_HOST_KEY ? 'This PC' : (host?.name ?? hostKey)} ·{' '}
            {folderName(session.projectPath)}
            {session.branch ? ` · ${session.branch}` : ''}
          </div>
        </div>
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
                    search: { host: hostKey, project: session.projectPath },
                  })
                }}
              >
                <Plus size={15} />
                New session in this folder
              </button>
              <button
                className="menu-row"
                onClick={() => {
                  void navigator.clipboard?.writeText(session.cwd)
                  close()
                }}
              >
                <Copy size={15} />
                Copy folder path
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
          <Transcript
            items={session.items}
            cwd={session.cwd}
            onOpenFile={(path) => {
              useUiStore.getState().openPane('files')
              void useFiles.getState().open(folderId(hostKey, session.cwd), path)
            }}
            onApprove={(requestId, optionId) => approve(sessionId, requestId, optionId)}
          />
        </div>
      </div>
      {actionError && (
        <p className="thread-action-error" role="alert">
          {actionError}
        </p>
      )}
      <Composer
        text={text}
        onTextChange={setText}
        placeholder={session.items.length === 0 ? 'Describe a task…' : 'Ask for follow-up changes'}
        busy={busy}
        onStop={() => {
          setActionError(undefined)
          void interrupt(sessionId).catch((err: unknown) =>
            setActionError(err instanceof Error ? err.message : String(err)),
          )
        }}
        onSend={(value, attachments) => prompt(sessionId, value, attachments)}
        modes={modes}
        modeId={session.currentModeId}
        onModeChange={(id) => void setMode(sessionId, id)}
        modelSlot={
          <ModelBadge
            models={provider?.capabilities.models ?? []}
            model={session.model}
            effort={session.effort}
          />
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
      <SessionPanel
        key={session.id}
        session={session}
        hostKey={hostKey}
        agent={agent ?? session.instanceId}
        stats={stats}
      />
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
          <Folder size={14} /> {folderName(session.projectPath)}
        </span>
      )}
      <span className="spacer" />
      {session.branch && (
        <span className="chip-lite static">
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
          <Folder size={14} /> Worktree
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
