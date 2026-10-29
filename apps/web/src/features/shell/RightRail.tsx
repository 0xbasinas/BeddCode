import {
  FolderOpen,
  GitBranch,
  Globe,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  SquareTerminal,
} from 'lucide-react'
import { lazy, Suspense, useEffect, type ComponentType, type ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useSession, useSessionHostKey } from '../../stores/host.ts'
import { HostScopeProvider } from '../../stores/HostScope.tsx'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { useComposerWorkspace, type PaneWorkspace } from '../../stores/composerWorkspace.ts'
import { useUiStore, type PaneId } from '../../stores/ui.ts'
import { isMac } from '../../ui/desktop.ts'
import { MissingFolder, useFolderMissing } from './MissingFolder.tsx'
import { EMPTY_FOLDER, folderId, useFiles } from '../files/filesStore.ts'

const BrowserPane = lazy(() =>
  import('../browser/BrowserPane.tsx').then((m) => ({ default: m.BrowserPane })),
)
const DesktopPane = lazy(() =>
  import('../desktop/DesktopPane.tsx').then((m) => ({ default: m.DesktopPane })),
)
const FilesPane = lazy(() =>
  import('../files/FilesPane.tsx').then((m) => ({ default: m.FilesPane })),
)
const GitPane = lazy(() => import('../git/GitPane.tsx').then((m) => ({ default: m.GitPane })))
const TerminalPane = lazy(() =>
  import('../terminal/TerminalPane.tsx').then((m) => ({ default: m.TerminalPane })),
)

const panes: { id: PaneId; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'files', label: 'Files', Icon: FolderOpen },
  { id: 'git', label: 'Git', Icon: GitBranch },
  { id: 'browser', label: 'Browser', Icon: Globe },
  { id: 'desktop', label: 'Desktop', Icon: Monitor },
]

/** The session currently open in the thread view, from the route. */
function useActiveSessionId(): string | undefined {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return /^\/session\/([^/]+)/.exec(path)?.[1]
}

export function RightRail({ wantWidth }: { wantWidth(px: number): void }) {
  const activePane = useUiStore((s) => s.activePane)
  const togglePane = useUiStore((s) => s.togglePane)
  const togglePaneCollapsed = useUiStore((s) => s.togglePaneCollapsed)
  const lastPane = useUiStore((s) => s.lastPane)
  const lastLabel = panes.find((p) => p.id === lastPane)?.label ?? 'pane'
  const sessionId = useActiveSessionId()
  const session = useSession(sessionId)
  const sessionHostKey = useSessionHostKey(sessionId)
  const composer = useComposerWorkspace((s) => s.workspace)
  const isComposer = useRouterState({ select: (s) => s.location.pathname === '/' })
  const workspace: PaneWorkspace | undefined = session
    ? {
        cwd: session.cwd,
        sessionId: session.id,
        draftId: session.id,
        title: session.title,
        instanceId: session.instanceId,
        branch: session.branch,
        status: session.status,
        worktree: Boolean(session.worktree),
        projectPath: session.projectless ? undefined : session.projectPath,
      }
    : isComposer
      ? composer
      : undefined
  const hostKey = sessionId
    ? (sessionHostKey ?? LOCAL_HOST_KEY)
    : ((isComposer ? composer?.hostKey : undefined) ?? LOCAL_HOST_KEY)
  const workspaceKey = workspace ? JSON.stringify([hostKey, workspace.cwd, workspace.draftId]) : ''
  // The editor needs room: the files pane grows once a file is open.
  const editorOpen = useFiles((s) =>
    workspace ? (s.byCwd[folderId(hostKey, workspace.cwd)] ?? EMPTY_FOLDER).tabs.length > 0 : false,
  )

  // Room for what is open: the editor wants a wide column, the browser a wider one still.
  const wanted = activePane === 'browser' ? 680 : activePane === 'files' && editorOpen ? 640 : 0
  useEffect(() => {
    if (wanted) wantWidth(wanted)
  }, [wanted, wantWidth])

  const folderMissing = useFolderMissing(hostKey, workspace)

  const needFolder = (render: (s: PaneWorkspace) => ReactNode) =>
    workspace ? (
      folderMissing ? (
        <MissingFolder session={workspace} />
      ) : (
        render(workspace)
      )
    ) : (
      <div className="git-empty muted">Choose a folder in the composer to use this pane.</div>
    )

  return (
    <div
      className={`right ${activePane ? 'has-pane' : ''} ${activePane === 'browser' ? 'browser-open' : ''} ${activePane === 'files' && editorOpen ? 'editor-open' : ''}`}
    >
      {/* At the start of the open pane's header row, left of its tabs or title; with the pane
          collapsed, on the same line at the left of the rail and window buttons. */}
      <button
        className="icon-btn pane-collapse"
        aria-label={activePane ? 'Collapse pane' : `Expand ${lastLabel} pane`}
        title={`${activePane ? 'Collapse pane' : `Expand ${lastLabel}`} (${isMac() ? '⌥⌘B' : 'Ctrl+Alt+B'})`}
        aria-expanded={Boolean(activePane)}
        onClick={togglePaneCollapsed}
      >
        {activePane ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
      </button>
      {activePane && (
        <section
          className={`panel side-pane ${activePane === 'files' && editorOpen ? 'wide' : ''}`}
          aria-label={activePane}
        >
          <HostScopeProvider hostKey={hostKey}>
            <Suspense
              fallback={
                <div className="git-empty muted" role="status">
                  Loading pane…
                </div>
              }
            >
              {activePane === 'git' &&
                needFolder((s) => <GitPane key={workspaceKey} workspace={s} />)}
              {activePane === 'terminal' &&
                needFolder((s) => <TerminalPane key={workspaceKey} workspace={s} />)}
              {activePane === 'files' &&
                needFolder((s) => <FilesPane key={workspaceKey} workspace={s} />)}
              {activePane === 'browser' && <BrowserPane draftId={workspace?.draftId} />}
              {activePane === 'desktop' &&
                (session ? (
                  <DesktopPane
                    key={`${hostKey}:${session.id}`}
                    sessionId={session.id}
                    working={session.status !== 'idle'}
                  />
                ) : (
                  <div className="git-empty muted">Open a session to see its desktop.</div>
                ))}
            </Suspense>
          </HostScopeProvider>
        </section>
      )}
      <nav className="rail" aria-label="Panes">
        {panes.map(({ id, label, Icon }) => (
          <button
            key={id}
            title={label}
            aria-label={label}
            aria-pressed={activePane === id}
            onClick={() => togglePane(id)}
          >
            <Icon size={20} />
          </button>
        ))}
      </nav>
    </div>
  )
}
