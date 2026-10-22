import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderGit2,
  GitBranch,
  House,
  Loader2,
  Monitor,
  Server,
  X,
} from 'lucide-react'
import type { FolderListing } from '@beddcode/contracts'
import { hostRequest, useRuntime } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { closeBrowser, rememberHome, useFolderFlow } from './folderFlow.ts'
import { folderBaseName, modifiedLabel, samePath, shortPath, visibleCrumbs } from './folderLogic.ts'
import './folders.css'

/** Shown while the in-app folder browser is open (other hosts, or the web app without Electron). */
export function FolderBrowserLayer() {
  const browser = useFolderFlow((s) => s.browser)
  return browser ? <FolderBrowserDialog key={browser.id} hostKey={browser.hostKey} /> : null
}

/**
 * Browses folders on a host to pick one. Paths are only ever shown, never typed: you click your
 * way there, and the folder you end up on (or the one you selected in it) is what gets added.
 */
function FolderBrowserDialog({ hostKey }: { hostKey: string }) {
  const { host, projects } = useRuntime(hostKey)
  const [listing, setListing] = useState<FolderListing>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [selected, setSelected] = useState<string>()
  const list = useRef<HTMLDivElement>(null)
  const local = hostKey === LOCAL_HOST_KEY
  const hostName = local ? 'This PC' : (host?.name ?? 'this host')

  const open = useCallback(
    (path?: string) => {
      setLoading(true)
      setError(undefined)
      hostRequest(hostKey, 'folders.browse', path ? { path } : {}).then(
        (next) => {
          setListing(next)
          setSelected(undefined)
          setLoading(false)
          rememberHome(hostKey, next.home)
          list.current?.scrollTo({ top: 0 })
        },
        (err: unknown) => {
          setError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        },
      )
    },
    [hostKey],
  )
  useEffect(() => open(), [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        closeBrowser(null)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const chosen = selected ?? listing?.path
  const crumbs = listing ? visibleCrumbs(listing.crumbs) : []
  const isAdded = (p: string) => projects.some((x) => samePath(x.path, p))

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && closeBrowser(null)}
    >
      <div
        className="folder-browser"
        role="dialog"
        aria-modal="true"
        aria-labelledby="folder-browser-title"
      >
        <header className="fb-head">
          <span className="fb-host-icon">
            {local ? <Monitor size={14} /> : <Server size={14} />}
          </span>
          <div>
            <h2 id="folder-browser-title">Choose a folder on {hostName}</h2>
            <p>
              {local
                ? 'Click your way to the folder your agent should work in.'
                : `Your system picker can't see other machines, so browse ${hostName} here.`}
            </p>
          </div>
          <button className="icon-btn small" aria-label="Close" onClick={() => closeBrowser(null)}>
            <X size={15} />
          </button>
        </header>
        <nav className="fb-crumbs" aria-label="Folder path">
          {crumbs.map((c, i) => (
            <span key={c.path} className="fb-crumb-wrap">
              {i > 0 && <ChevronRight size={12} className="fb-crumb-sep" />}
              <button
                className={`fb-crumb ${i === crumbs.length - 1 ? 'current' : ''}`}
                aria-current={i === crumbs.length - 1 ? 'location' : undefined}
                onClick={() => open(c.path)}
              >
                {c.home && <House size={13} />}
                {c.name}
              </button>
            </span>
          ))}
          {loading && <Loader2 size={13} className="fb-spin" />}
        </nav>
        <div className="fb-list" ref={list} role="listbox" aria-label="Folders">
          {listing?.parent && (
            <button className="fb-row up" onClick={() => open(listing.parent!)}>
              <CornerLeftUp size={15} />
              <span className="fb-name">{folderBaseName(listing.parent)}</span>
            </button>
          )}
          {error && (
            <div className="fb-message error" role="alert">
              {error}
            </div>
          )}
          {!error && listing && listing.entries.length === 0 && (
            <div className="fb-message">No folders in here. Select this folder, or go back up.</div>
          )}
          {listing?.entries.map((entry) => {
            const isSelected = selected !== undefined && samePath(selected, entry.path)
            const Icon = entry.isRepo ? FolderGit2 : Folder
            return (
              <div
                key={entry.path}
                className={`fb-row ${isSelected ? 'selected' : ''}`}
                role="option"
                aria-selected={isSelected}
                tabIndex={0}
                onClick={() => setSelected(entry.path)}
                onDoubleClick={() => open(entry.path)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === 'ArrowRight') {
                    e.preventDefault()
                    open(entry.path)
                  } else if (e.key === ' ') {
                    e.preventDefault()
                    setSelected(entry.path)
                  } else if ((e.key === 'Backspace' || e.key === 'ArrowLeft') && listing.parent) {
                    e.preventDefault()
                    open(listing.parent)
                  }
                }}
              >
                <Icon size={15} />
                <span className="fb-name">{entry.name}</span>
                {isAdded(entry.path) ? (
                  <span className="recent-added">
                    <Check size={11} /> Added
                  </span>
                ) : entry.isRepo ? (
                  entry.branch && (
                    <span className="folder-chip">
                      <GitBranch size={10} />
                      {entry.branch}
                    </span>
                  )
                ) : (
                  <span className="folder-chip faint">no git</span>
                )}
                <span className="fb-when">
                  {entry.modifiedAt !== undefined ? modifiedLabel(entry.modifiedAt) : ''}
                </span>
                <button
                  className="icon-btn small fb-open"
                  aria-label={`Open ${entry.name}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation()
                    open(entry.path)
                  }}
                >
                  <ChevronRight size={13} />
                </button>
              </div>
            )
          })}
          {listing?.truncated && (
            <div className="fb-message">Showing the first {listing.entries.length} folders.</div>
          )}
        </div>
        <footer className="fb-foot">
          <span className="fb-chosen" title={chosen}>
            {chosen ? shortPath(chosen, listing?.home) : ''}
          </span>
          <button className="setup-button fb-cancel" onClick={() => closeBrowser(null)}>
            Cancel
          </button>
          <button
            className="setup-button primary"
            disabled={!chosen || loading}
            onClick={() => chosen && closeBrowser(chosen)}
          >
            Select this folder
          </button>
        </footer>
      </div>
    </div>
  )
}
