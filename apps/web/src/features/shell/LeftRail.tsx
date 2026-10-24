import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Layers, Plus, Search, Settings } from 'lucide-react'
import { useAllSessions, useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { useUiStore } from '../../stores/ui.ts'
import { chooseFolder } from '../folders/folderFlow.ts'
import { workspaceHue, workspaceInitials, workspaceKey } from './workspaces.ts'
import './leftRail.css'

/**
 * The slim column at the left edge: one icon per workspace (a folder on a host). Choosing one
 * narrows the session list to it; choosing it again, or the stack icon, shows everything.
 */
export function LeftRail() {
  const navigate = useNavigate()
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const sessions = useAllSessions()
  const workspace = useUiStore((s) => s.workspace)
  const setWorkspace = useUiStore((s) => s.setWorkspace)
  const setSearchOpen = useUiStore((s) => s.setSearchOpen)
  const multiHost = entries.length > 1

  const items = entries.flatMap((entry) =>
    (runtimes[entry.key]?.projects ?? []).map((project) => ({
      key: workspaceKey(entry.key, project.path),
      name: project.name,
      host: runtimes[entry.key]?.host?.name ?? entry.name,
      path: project.path,
    })),
  )
  // What each workspace is doing, for the dot on its icon: needs you wins over running.
  const state = new Map<string, 'needs-you' | 'running'>()
  for (const { hostKey, session } of sessions) {
    if (session.projectless || session.status === 'idle' || session.status === 'failed') continue
    const key = workspaceKey(hostKey, session.projectPath)
    if (session.status === 'needs-you' || !state.has(key)) state.set(key, session.status)
  }

  // A workspace that was removed cannot stay selected.
  useEffect(() => {
    if (workspace && items.length > 0 && !items.some((i) => i.key === workspace)) {
      setWorkspace(null)
    }
  })

  return (
    <nav className="left-rail" aria-label="Workspaces">
      <div className="left-rail-list">
        <button
          type="button"
          className={`rail-item ${workspace === null ? 'on' : ''}`}
          title="All workspaces"
          aria-label="All workspaces"
          aria-pressed={workspace === null}
          onClick={() => setWorkspace(null)}
        >
          <Layers size={18} />
        </button>
        {items.length > 0 && <div className="left-rail-sep" />}
        {items.map((item) => {
          const hue = workspaceHue(item.name)
          const on = workspace === item.key
          return (
            <button
              key={item.key}
              type="button"
              className={`rail-item workspace ${on ? 'on' : ''}`}
              title={`${item.name}${multiHost ? ` · ${item.host}` : ''}\n${item.path}`}
              aria-label={item.name}
              aria-pressed={on}
              style={{
                ['--hue' as string]: hue,
              }}
              onClick={() => setWorkspace(on ? null : item.key)}
            >
              <span className="rail-initials">{workspaceInitials(item.name)}</span>
              {state.has(item.key) && <span className={`rail-dot ${state.get(item.key)}`} />}
            </button>
          )
        })}
        <button
          type="button"
          className="rail-item add"
          title="Add a folder"
          aria-label="Add a folder"
          onClick={() => void chooseFolder(LOCAL_HOST_KEY)}
        >
          <Plus size={18} />
        </button>
      </div>
      <div className="left-rail-foot">
        <button
          type="button"
          className="rail-item"
          title="Search sessions (Ctrl+K)"
          aria-label="Search sessions"
          onClick={() => setSearchOpen(true)}
        >
          <Search size={18} />
        </button>
        <button
          type="button"
          className="rail-item"
          title="Settings"
          aria-label="Settings"
          onClick={() => void navigate({ to: '/settings' })}
        >
          <Settings size={18} />
        </button>
      </div>
    </nav>
  )
}
