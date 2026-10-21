import { FolderOpen, GitBranch, Globe, SquareTerminal } from 'lucide-react'
import type { ComponentType, ReactNode } from 'react'
import { useRouterState } from '@tanstack/react-router'
import { useSession, useSessionHostKey } from '../../stores/host.ts'
import { HostScopeProvider } from '../../stores/HostScope.tsx'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { useUiStore, type PaneId } from '../../stores/ui.ts'
import { BrowserPane } from '../browser/BrowserPane.tsx'
import { EMPTY_FOLDER, folderId, useFiles } from '../files/filesStore.ts'
import { FilesPane } from '../files/FilesPane.tsx'
import { GitPane } from '../git/GitPane.tsx'
import { TerminalPane } from '../terminal/TerminalPane.tsx'

const panes: { id: PaneId; label: string; Icon: ComponentType<{ size?: number }> }[] = [
  { id: 'terminal', label: 'Terminal', Icon: SquareTerminal },
  { id: 'files', label: 'Files', Icon: FolderOpen },
  { id: 'git', label: 'Git', Icon: GitBranch },
  { id: 'browser', label: 'Browser', Icon: Globe },
]

/** The session currently open in the thread view, from the route. */
function useActiveSessionId(): string | undefined {
  const path = useRouterState({ select: (s) => s.location.pathname })
  return /^\/session\/([^/]+)/.exec(path)?.[1]
}

export function RightRail() {
  const activePane = useUiStore((s) => s.activePane)
  const togglePane = useUiStore((s) => s.togglePane)
  const sessionId = useActiveSessionId()
  const session = useSession(sessionId)
  const hostKey = useSessionHostKey(sessionId) ?? LOCAL_HOST_KEY
  // The editor needs room: the files pane grows once a file is open.
  const editorOpen = useFiles((s) =>
    session ? (s.byCwd[folderId(hostKey, session.cwd)] ?? EMPTY_FOLDER).tabs.length > 0 : false,
  )

  const needSession = (render: (s: NonNullable<typeof session>) => ReactNode) =>
    session ? (
      render(session)
    ) : (
      <div className="git-empty muted">Open a session to use this pane.</div>
    )

  return (
    <div
      className={`right ${activePane ? 'has-pane' : ''} ${activePane === 'browser' ? 'browser-open' : ''} ${activePane === 'files' && editorOpen ? 'editor-open' : ''}`}
    >
      {activePane && (
        <section
          className={`panel side-pane ${activePane === 'files' && editorOpen ? 'wide' : ''}`}
          aria-label={activePane}
        >
          <HostScopeProvider hostKey={hostKey}>
            {activePane === 'git' && needSession((s) => <GitPane key={s.id} session={s} />)}
            {activePane === 'terminal' &&
              needSession((s) => <TerminalPane key={s.id} session={s} />)}
            {activePane === 'files' && needSession((s) => <FilesPane key={s.id} session={s} />)}
            {activePane === 'browser' && <BrowserPane />}
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
