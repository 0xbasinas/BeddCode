import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Copy, Folder, GitBranch, Trash2 } from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import { Composer } from '../composer/Composer.tsx'
import { ModelBadge } from '../composer/Menus.tsx'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { hostRequest, useHostStore } from '../../stores/host.ts'
import { folderName } from '../../ui/format.ts'
import { Transcript } from './Transcript.tsx'
import { buildBlocks, totalChanges } from './blocks.ts'
import { useFollowEnd } from './useFollowEnd.ts'

export function ThreadView({ sessionId }: { sessionId: string }) {
  const session = useHostStore((s) => s.replica.sessions[sessionId])
  const synced = useHostStore((s) => s.synced)
  const providers = useHostStore((s) => s.providers)
  const { approve, prompt, interrupt, setMode } = useHostStore.getState()
  const [text, setText] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  useFollowEnd(scroller, session?.items)

  const pending = useMemo(
    () => session?.items.findLast((i) => i.kind === 'approval' && !i.resolvedOptionId),
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
      void approve(sessionId, pending.requestId, option.id)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pending, sessionId, approve])

  if (!session) {
    return <main className="panel thread-empty">{synced ? 'Session not found' : 'Loading…'}</main>
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
        <h1>{session.title}</h1>
        <div className="thread-meta">
          {provider?.label ?? session.instanceId} · {session.cwd}
        </div>
      </header>
      <div className="transcript" ref={scroller}>
        <div className="transcript-inner">
          <Transcript
            items={session.items}
            cwd={session.cwd}
            onApprove={(requestId, optionId) => void approve(sessionId, requestId, optionId)}
          />
        </div>
      </div>
      <Composer
        text={text}
        onTextChange={setText}
        placeholder={session.items.length === 0 ? 'Describe a task…' : 'Ask for follow-up changes'}
        busy={busy}
        onStop={() => void interrupt(sessionId)}
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
        footer={<SessionFooter session={session} agent={provider?.label} stats={stats} />}
      />
    </main>
  )
}

function SessionFooter({
  session,
  agent,
  stats,
}: {
  session: SessionView
  agent: string | undefined
  stats: { added: number; removed: number }
}) {
  return (
    <div className="footer-bar">
      <span className="chip-lite">{agent ?? session.instanceId}</span>
      <span className="sep" />
      {session.worktree ? (
        <WorktreeChip session={session} />
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
function WorktreeChip({ session }: { session: SessionView }) {
  const navigate = useNavigate()
  const [error, setError] = useState<string>()
  const [copied, setCopied] = useState(false)

  const remove = async (close: () => void) => {
    if (!window.confirm('Delete this worktree? The branch and its commits are kept.')) return
    try {
      await hostRequest('worktrees.remove', { sessionId: session.id })
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
