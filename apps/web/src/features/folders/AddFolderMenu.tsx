import { useEffect, useMemo, useState } from 'react'
import {
  Check,
  ChevronDown,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Monitor,
  Server,
} from 'lucide-react'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { hostRequest, useHostStore, useRuntime } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { isMac } from '../../ui/desktop.ts'
import { addFolder, chooseFolder, useFolderFlow, useHostHome } from './folderFlow.ts'
import { browseShortcut, recentFolders, shortPath, type RecentFolder } from './folderLogic.ts'
import './folders.css'

const hostLabel = (key: string, name?: string) =>
  key === LOCAL_HOST_KEY ? 'This PC' : (name ?? key)

/**
 * The one way to add a folder: a small menu with the host, Browse… (the system picker on this
 * computer, the in-app browser on others) and recent folders. There is no path to type.
 */
export function AddFolderMenu() {
  const hostKey = useFolderFlow((s) => s.menuHostKey)
  return (
    <Dropdown
      placement="bottom"
      align="end"
      panelClassName="add-folder-pop"
      trigger={({ open, toggle }) => (
        <button
          className={`folders-add ${open ? 'on' : ''}`}
          aria-label="Add folder"
          aria-expanded={open}
          onClick={toggle}
        >
          <FolderPlus size={14} /> Add folder
        </button>
      )}
    >
      {(close) => <AddFolderPanel key={hostKey} hostKey={hostKey} close={close} />}
    </Dropdown>
  )
}

function AddFolderPanel({ hostKey, close }: { hostKey: string; close(): void }) {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const setMenuHostKey = useFolderFlow((s) => s.setMenuHostKey)
  const history = useFolderFlow((s) => s.history[hostKey])
  const { projects, replica, host, connection } = useRuntime(hostKey)
  const [choosingHost, setChoosingHost] = useState(false)
  const recent = useMemo(
    () =>
      recentFolders({
        history: history ?? [],
        sessionPaths: replica.order.flatMap((id) => {
          const session = replica.sessions[id]!
          return session.projectless ? [] : [session.projectPath]
        }),
        projects,
      }),
    [history, replica, projects],
  )
  const [keys] = useState(() => browseShortcut(isMac()))
  const connected = connection === 'connected'
  const home = useHostHome(hostKey, connected)

  if (choosingHost)
    return (
      <>
        <div className="menu-heading">Add a folder on</div>
        {entries.map((e) => {
          const online = runtimes[e.key]?.connection === 'connected'
          return (
            <button
              key={e.key}
              className="menu-row"
              role="menuitemradio"
              aria-checked={e.key === hostKey}
              disabled={!online}
              onClick={() => {
                setMenuHostKey(e.key)
                setChoosingHost(false)
              }}
            >
              {e.key === LOCAL_HOST_KEY ? <Monitor size={15} /> : <Server size={15} />}
              <span className="menu-text">
                <span className="menu-title">
                  {hostLabel(e.key, runtimes[e.key]?.host?.name ?? e.name)}
                </span>
                {!online && <span className="menu-desc">Offline</span>}
              </span>
              {e.key === hostKey && <Check size={14} />}
            </button>
          )
        })}
      </>
    )

  return (
    <>
      <div className="menu-heading add-folder-head">
        <span>Add a folder on</span>
        <button
          className="add-folder-host"
          aria-label="Choose host"
          disabled={entries.length < 2}
          onClick={() => setChoosingHost(true)}
        >
          {hostKey === LOCAL_HOST_KEY ? <Monitor size={11} /> : <Server size={11} />}
          {hostLabel(hostKey, host?.name)}
          {entries.length > 1 && <ChevronDown size={10} />}
        </button>
      </div>
      <button
        className="menu-row"
        disabled={!connected}
        onClick={() => {
          close()
          void chooseFolder(hostKey)
        }}
      >
        <FolderOpen size={15} />
        <span className="menu-text">Browse…</span>
        <span className="add-folder-keys">
          <kbd>{keys[0]}</kbd>
          <kbd>{keys[1]}</kbd>
        </span>
      </button>
      {!connected && <div className="menu-desc add-folder-note">This host is not connected</div>}
      {recent.length > 0 && (
        <>
          <div className="menu-sep" />
          <div className="menu-heading">Recent</div>
          {recent.map((r) => (
            <RecentRow
              key={r.path}
              hostKey={hostKey}
              folder={r}
              home={home}
              disabled={!connected}
              onPick={() => {
                close()
                void addFolder(hostKey, r.path)
              }}
            />
          ))}
        </>
      )}
    </>
  )
}

/** One recent folder; git details of folders not added yet are looked up when the menu opens. */
function RecentRow({
  hostKey,
  folder,
  home,
  disabled,
  onPick,
}: {
  hostKey: string
  folder: RecentFolder
  home?: string
  disabled: boolean
  onPick(): void
}) {
  const [git, setGit] = useState<{ isRepo: boolean; branch?: string } | 'missing' | undefined>(
    folder.isRepo === undefined ? undefined : { isRepo: folder.isRepo, branch: folder.branch },
  )
  useEffect(() => {
    if (folder.isRepo !== undefined || disabled) return
    let cancelled = false
    hostRequest(hostKey, 'git.info', { cwd: folder.path }).then(
      (info) => !cancelled && setGit({ isRepo: info.isRepo, branch: info.branch }),
      () => !cancelled && setGit('missing'),
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, folder.path, folder.isRepo, disabled])
  // A folder that was moved or deleted since is not offered again.
  if (git === 'missing') return null
  const Icon = git?.isRepo ? FolderGit2 : Folder
  return (
    <button
      className={`menu-row recent-folder ${folder.added ? 'added' : ''}`}
      disabled={disabled || folder.added}
      title={folder.path}
      onClick={onPick}
    >
      <Icon size={15} />
      <span className="menu-text">
        <span className="menu-title">{folder.name}</span>
        <span className="recent-path">{shortPath(folder.path, home)}</span>
      </span>
      {folder.added ? (
        <span className="recent-added">
          <Check size={11} /> Added
        </span>
      ) : git?.isRepo ? (
        git.branch && (
          <span className="folder-chip">
            <GitBranch size={10} />
            {git.branch}
          </span>
        )
      ) : git ? (
        <span className="folder-chip faint">no git</span>
      ) : null}
    </button>
  )
}
