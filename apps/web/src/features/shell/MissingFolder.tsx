import { useEffect, useState } from 'react'
import { FolderX } from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import { hostRequest, useRuntime } from '../../stores/host.ts'

/** True once the host says the session's folder is gone (a deleted worktree, a moved project). */
export function useFolderMissing(hostKey: string, session: SessionView | undefined): boolean {
  const { epoch } = useRuntime(hostKey)
  const cwd = session?.cwd
  const [missing, setMissing] = useState(false)

  useEffect(() => {
    setMissing(false)
    if (!cwd || epoch === 0) return
    let cancelled = false
    hostRequest(hostKey, 'files.list', { cwd, dir: '' }).then(
      () => !cancelled && setMissing(false),
      (err: unknown) =>
        !cancelled && setMissing(err instanceof Error && /does not exist/i.test(err.message)),
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, cwd, epoch])

  return missing
}

/** Shown in place of a pane whose folder no longer exists, instead of a raw error. */
export function MissingFolder({ session }: { session: SessionView }) {
  return (
    <div className="git-empty">
      <FolderX size={22} />
      <div>{session.worktree ? 'This worktree was removed' : 'This folder no longer exists'}</div>
      <div className="muted">
        {session.worktree
          ? 'Its branch and the conversation are kept.'
          : 'It may have been moved or deleted.'}
      </div>
      <code className="muted">{session.cwd}</code>
    </div>
  )
}
