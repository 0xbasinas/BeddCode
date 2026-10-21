import { useState } from 'react'
import { Check, Folder, Server } from 'lucide-react'
import { Link } from '@tanstack/react-router'
import { useRuntime } from '../../stores/host.ts'
import { HostsDialog } from '../hosts/HostsDialog.tsx'
import { useUiStore } from '../../stores/ui.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'

export function Welcome({
  hostKey,
  onAddFolder,
  onSkip,
}: {
  hostKey: string
  onAddFolder(path: string): Promise<void>
  onSkip(): void
}) {
  const { connection, providers, host } = useRuntime(hostKey)
  const [hostsOpen, setHostsOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const [path, setPath] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const connected = connection === 'connected'
  const ready = providers.some((provider) => provider.status === 'ready')

  const add = async () => {
    if (!path.trim() || busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onAddFolder(path.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="panel welcome-panel">
      <div className="welcome-content">
        <header>
          <h1>Welcome to BeddCode</h1>
          <p>
            Supervise coding agents like Claude Code, Codex and Gemini CLI across all your machines.
            Three quick steps and you are running.
          </p>
        </header>
        <div className="setup-checklist">
          <div className="setup-row">
            <span className={`setup-number ${connected ? 'complete' : ''}`}>
              {connected ? <Check size={15} /> : <Server size={14} />}
            </span>
            <div>
              <h2>Connect a host</h2>
              <p>
                {connected
                  ? `${hostKey === LOCAL_HOST_KEY ? 'This PC' : (host?.name ?? 'Your host')} is connected`
                  : 'Connect this PC or a remote machine'}
              </p>
            </div>
            {connected ? (
              <span className="setup-done">Done</span>
            ) : (
              <button className="setup-button" onClick={() => setHostsOpen(true)}>
                Connect
              </button>
            )}
          </div>
          <div className="setup-row">
            <span className="setup-number current">2</span>
            <div>
              <h2>Add a folder</h2>
              <p>Pick a repository for your agent to work in</p>
            </div>
            <button
              className="setup-button primary"
              disabled={!connected}
              onClick={() => setAdding((open) => !open)}
            >
              <Folder size={13} /> Add folder
            </button>
          </div>
          {adding && (
            <form
              className="setup-folder-form"
              onSubmit={(e) => {
                e.preventDefault()
                void add()
              }}
            >
              <label htmlFor="setup-folder">Folder on this host</label>
              <div>
                <input
                  id="setup-folder"
                  autoFocus
                  placeholder="Absolute path to your project"
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  disabled={busy}
                />
                <button
                  className="setup-button primary"
                  disabled={busy || !path.trim() || !connected}
                >
                  {busy ? 'Adding…' : 'Add folder'}
                </button>
              </div>
              {error && (
                <p className="composer-error" role="alert">
                  {error}
                </p>
              )}
            </form>
          )}
          <div className="setup-row pending">
            <span className="setup-number">3</span>
            <div>
              <h2>Start a session</h2>
              <p>
                {ready ? 'Describe a task and send it' : 'Set up an agent, then describe a task'}
              </p>
            </div>
            {connected && !ready && (
              <Link to="/settings" className="setup-button">
                Set up agents
              </Link>
            )}
          </div>
        </div>
        <footer>
          <button onClick={onSkip}>Skip setup</button>
          <button
            className="setup-shortcut"
            onClick={() => useUiStore.getState().setSearchOpen(true)}
          >
            Search sessions <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </button>
        </footer>
      </div>
      {hostsOpen && <HostsDialog onClose={() => setHostsOpen(false)} />}
    </main>
  )
}

export function setupWasSkipped() {
  try {
    return localStorage.getItem('beddcode.setup-skipped') === '1'
  } catch {
    return false
  }
}

export function skipSetup() {
  try {
    localStorage.setItem('beddcode.setup-skipped', '1')
  } catch {
    /* Still dismiss for this window. */
  }
}
