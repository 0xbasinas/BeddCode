import { useState } from 'react'
import { Check, FolderOpen, Loader2, Plus, Server } from 'lucide-react'
import { Link, useNavigate } from '@tanstack/react-router'
import { readyProviders, useRuntime } from '../../stores/host.ts'
import { HostsDialog } from '../hosts/HostsDialog.tsx'
import { useUiStore } from '../../stores/ui.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { chooseFolder, hasNativePicker, useFolderFlow } from '../folders/folderFlow.ts'
import { samePath } from '../folders/folderLogic.ts'
import { defaultAgent, hostDefaults, usePreferences } from '../../stores/preferences.ts'
import '../folders/folders.css'

export { showWelcome } from './welcomeLogic.ts'

export function Welcome({ hostKey, onSkip }: { hostKey: string; onSkip(): void }) {
  const navigate = useNavigate()
  const { connection, providers, host, projects } = useRuntime(hostKey)
  const [hostsOpen, setHostsOpen] = useState(false)
  const picking = useFolderFlow((s) => s.picking || s.browser !== undefined)
  const lastAdded = useFolderFlow((s) => s.lastAdded[hostKey])
  const defaults = usePreferences((s) => hostDefaults(s.hosts, host?.hostId ?? hostKey))
  const connected = connection === 'connected'
  const ready = readyProviders(providers).length > 0
  const agent = defaultAgent(providers, defaults.instanceId)
  const hostName = hostKey === LOCAL_HOST_KEY ? 'This PC' : (host?.name ?? 'Your host')
  // The folder just added, else the newest one the host knows.
  const folder = (lastAdded && projects.find((p) => samePath(p.path, lastAdded))) ?? projects.at(-1)
  const native = hasNativePicker(hostKey)

  const choose = () => void chooseFolder(hostKey)
  const start = () =>
    folder && void navigate({ to: '/', search: { project: folder.path, host: hostKey } })

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
                {connected ? `${hostName} is connected` : 'Connect this PC or a remote machine'}
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
          {folder ? (
            <div className="setup-row">
              <span className="setup-number complete">
                <Check size={15} />
              </span>
              <div>
                <h2>Add a folder</h2>
                <p>
                  {folder.name} on {hostName}
                </p>
              </div>
              <button className="setup-link" disabled={picking} onClick={choose}>
                Add another
              </button>
            </div>
          ) : (
            <div className="setup-row">
              <span className="setup-number current">2</span>
              <div>
                <h2>Add a folder</h2>
                <p>
                  {picking && native
                    ? 'Waiting for the folder picker…'
                    : 'Pick a repository for your agent to work in'}
                </p>
                {!picking && (
                  <div className="setup-hint">
                    <FolderOpen size={11} />
                    {native
                      ? "Opens your system's folder picker"
                      : `Browse the folders on ${hostName}`}
                  </div>
                )}
              </div>
              <button
                className="setup-button primary"
                disabled={!connected || picking}
                onClick={choose}
              >
                {picking ? (
                  <>
                    <Loader2 size={13} className="fb-spin" /> Choosing…
                  </>
                ) : (
                  <>
                    <FolderOpen size={13} /> Choose folder…
                  </>
                )}
              </button>
            </div>
          )}
          <div className={`setup-row ${folder ? '' : 'pending'}`}>
            <span className={`setup-number ${folder ? 'current' : ''}`}>3</span>
            <div>
              <h2>Start a session</h2>
              <p>
                {!folder
                  ? 'Add a folder first, then describe a task'
                  : ready && agent
                    ? `${agent.label} is ready in ${folder.name}`
                    : 'Set up an agent, then describe a task'}
              </p>
            </div>
            {folder && ready && (
              <button className="setup-button primary" onClick={start}>
                <Plus size={13} /> Start a session
              </button>
            )}
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
