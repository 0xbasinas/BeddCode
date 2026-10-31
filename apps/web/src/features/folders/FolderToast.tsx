import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useNavigate } from '@tanstack/react-router'
import { AlertCircle, Check, FolderGit2, FolderOpen, Info, X } from 'lucide-react'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { useRuntime } from '../../stores/host.ts'
import { initGit, useFolderFlow, type FolderToast as Toast } from './folderFlow.ts'
import './folders.css'

const AUTO_HIDE_MS = 12_000

/** What happened after a folder was picked: added, not a repository, or already there. */
export function FolderToast() {
  const toast = useFolderFlow((s) => s.toast)
  const dismiss = useFolderFlow((s) => s.dismissToast)
  const [hovered, setHovered] = useState(false)
  useEffect(() => {
    if (!toast || hovered) return
    const timer = setTimeout(() => {
      if (useFolderFlow.getState().toast?.id === toast.id) dismiss()
    }, AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [toast, hovered, dismiss])
  if (!toast) return null
  return (
    <div
      className="folder-toast"
      role="status"
      aria-live="polite"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <ToastBody toast={toast} onDismiss={dismiss} />
    </div>
  )
}

function ToastBody({ toast, onDismiss }: { toast: Toast; onDismiss(): void }) {
  const navigate = useNavigate()
  const { host } = useRuntime(toast.hostKey)
  const [busy, setBusy] = useState(false)
  const project = toast.project
  const hostName = toast.hostKey === LOCAL_HOST_KEY ? 'This PC' : (host?.name ?? 'your host')
  const startHere = () => {
    if (!project) return
    onDismiss()
    void navigate({ to: '/', search: { project: project.path, host: toast.hostKey } })
  }

  const [icon, iconClass, title, text] =
    toast.kind === 'error'
      ? [<AlertCircle size={12} />, 'error', "Couldn't add that folder", toast.message]
      : toast.kind === 'already'
        ? [
            <FolderGit2 size={12} />,
            'neutral',
            'Already added',
            `${project?.name} is already in your sidebar.`,
          ]
        : toast.kind === 'not-git'
          ? [
              <Info size={12} />,
              'info',
              'Folder added',
              `${project?.name} isn't a git repo. Agents can still work here, but worktrees and change review are off.`,
            ]
          : toast.kind === 'git-ready'
            ? [
                <Check size={12} />,
                '',
                'Git initialized',
                `${project?.name} is now a git repository.`,
              ]
            : [<Check size={12} />, '', 'Folder added', null]

  return (
    <>
      <span className={`folder-toast-icon ${iconClass}`}>{icon}</span>
      <div className="folder-toast-text">
        <h4>{title}</h4>
        <p>
          {text ?? (
            <>
              {project?.name} on {hostName}
              {project?.branch && (
                <>
                  {' · '}
                  <code>{project.branch}</code>
                </>
              )}
            </>
          )}
        </p>
        {project && (
          <div className="folder-toast-actions">
            <Button variant="app" className="setup-button primary" onClick={startHere}>
              Start a session here
            </Button>
            {toast.kind === 'not-git' ? (
              <Button
                variant="app"
                className="setup-button"
                disabled={busy}
                onClick={() => {
                  setBusy(true)
                  void initGit(toast.hostKey, project.path).finally(() => setBusy(false))
                }}
              >
                {busy ? 'Initializing…' : 'Initialize git'}
              </Button>
            ) : (
              <Button variant="app" className="setup-button ghost" onClick={onDismiss}>
                Dismiss
              </Button>
            )}
          </div>
        )}
      </div>
      <button
        className="icon-btn small folder-toast-close"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X size={13} />
      </button>
    </>
  )
}

/** While the system folder picker is open the app waits, dimmed, and says where to look. */
export function FolderPickerHint() {
  const picking = useFolderFlow((s) => s.picking)
  if (!picking) return null
  return (
    <div className="folder-picking" aria-live="polite">
      <div className="folder-picking-hint">
        <FolderOpen size={13} /> Choose a folder in the window that opened…
      </div>
    </div>
  )
}
