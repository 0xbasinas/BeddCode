import { AgentIcon, agentKind } from '../../ui/AgentMark.tsx'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { useState } from 'react'
import { ArrowLeft, Check, FolderOpen, Loader2, Monitor, RefreshCw, Server } from 'lucide-react'
import { useNavigate } from '@tanstack/react-router'
import { refreshProviders, useRuntime } from '../../stores/host.ts'
import { HostsDialog } from '../hosts/HostsDialog.tsx'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { chooseFolder, hasNativePicker, useFolderFlow } from '../folders/folderFlow.ts'
import { samePath } from '../folders/folderLogic.ts'
import {
  agentDefaults,
  defaultAgent,
  hostDefaults,
  usePreferences,
} from '../../stores/preferences.ts'
import { useNotificationPrefs } from '../../stores/notificationPrefs.ts'
import { Select } from '../../ui/Select.tsx'
import '../folders/folders.css'
import { Logo } from '../../ui/Logo.tsx'

export { showWelcome } from './welcomeLogic.ts'

const STEPS = 5
const STATUS_TEXT = {
  ready: 'Ready',
  'needs-sign-in': 'Needs sign-in',
  'not-installed': 'Not found on this PC',
  error: 'Unavailable',
} as const
const PLATFORM = { win32: 'Windows', linux: 'Linux', darwin: 'macOS' } as const

const initials = (label: string) =>
  label
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase()

/**
 * The first run, in five steps: welcome, this computer and its agents, a folder, how much agents
 * should ask, and a summary. Every step can be skipped; nothing here is needed later that Settings
 * does not also offer.
 */
export function Welcome({ hostKey, onSkip }: { hostKey: string; onSkip(): void }) {
  const navigate = useNavigate()
  const { connection, providers, host, projects, loadError } = useRuntime(hostKey)
  const [step, setStep] = useState(1)
  const [hostsOpen, setHostsOpen] = useState(false)
  const [scanning, setScanning] = useState(false)
  const picking = useFolderFlow((s) => s.picking || s.browser !== undefined)
  const lastAdded = useFolderFlow((s) => s.lastAdded[hostKey])
  const hostId = host?.hostId ?? hostKey
  const defaults = usePreferences((s) => hostDefaults(s.hosts, hostId))
  const setDefaultAgent = usePreferences((s) => s.setDefaultAgent)
  const setAgentDefaults = usePreferences((s) => s.setAgentDefaults)
  const notify = useNotificationPrefs()
  const connected = connection === 'connected'
  const agent = defaultAgent(providers, defaults.instanceId)
  const readyAgents = providers.filter((p) => p.status === 'ready')
  const hostName = hostKey === LOCAL_HOST_KEY ? 'This PC' : (host?.name ?? 'Your host')
  const folder = (lastAdded && projects.find((p) => samePath(p.path, lastAdded))) ?? projects.at(-1)
  const native = hasNativePicker(hostKey)
  const modes = agent?.capabilities.permissionModes ?? []
  const chosenMode = agentDefaults(defaults, agent).permissionMode ?? modes[0]?.id
  const modeLabel = modes.find((m) => m.id === chosenMode)?.label

  const next = () => setStep((s) => Math.min(STEPS, s + 1))
  const back = () => setStep((s) => Math.max(1, s - 1))
  const scan = async () => {
    setScanning(true)
    try {
      await refreshProviders(hostKey)
    } finally {
      setScanning(false)
    }
  }
  const finish = () =>
    void navigate({
      to: '/',
      search: folder ? { project: folder.path, host: hostKey } : { compose: true },
    })
  const setNotify = async (on: boolean) => {
    notify.update({ needsYou: on })
    if (on && typeof Notification !== 'undefined' && Notification.permission === 'default') {
      await Notification.requestPermission()
    }
  }

  return (
    <main className="panel welcome-panel wizard">
      <div className="wizard-body" key={step}>
        {step === 1 && (
          <>
            <Logo size={64} className="welcome-logo" />
            <h1>Welcome to BeddCode</h1>
            <p className="wizard-lead">
              Supervise coding agents like Claude Code, Codex and Grok across all your machines. A
              few quick steps and you are running.
            </p>
            <Button variant="app" className="wizard-primary" onClick={next}>
              Get started
            </Button>
            <button className="wizard-skip" onClick={onSkip}>
              Skip setup
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <StepHead
              step={step}
              title="Connect this computer"
              lead="Agents run on a host. Start with this PC, and add remote machines whenever you like."
            />
            <div className="wizard-card">
              <div className="wizard-row">
                <span className="wizard-icon">
                  <Monitor size={18} />
                </span>
                <div>
                  <strong>{hostName}</strong>
                  <small>
                    {host ? (PLATFORM[host.platform] ?? host.platform) : 'Starting…'}
                    {connected ? ' · detected' : ''}
                  </small>
                </div>
                <span className={`wizard-status ${connected ? 'ok' : ''}`}>
                  {connected ? 'Ready' : connection === 'denied' ? 'Not allowed' : 'Connecting…'}
                </span>
              </div>
            </div>
            <div className="wizard-label">
              <span>Agents found on {hostName}</span>
              <button disabled={!connected || scanning} onClick={() => void scan()}>
                <RefreshCw size={12} className={scanning ? 'fb-spin' : undefined} /> Scan again
              </button>
            </div>
            <div className="wizard-card">
              {providers.length === 0 && (
                <p className="wizard-empty">
                  {!connected
                    ? 'Waiting for the host…'
                    : loadError
                      ? `${loadError}. Trying again…`
                      : 'No agents were found yet.'}
                </p>
              )}
              {providers.map((p) => (
                <div className={`wizard-row ${p.status === 'ready' ? '' : 'dim'}`} key={p.id}>
                  <span className="wizard-icon">
                    {agentKind(p.id, p.label) ? (
                      <AgentIcon agent={p.id} label={p.label} size={18} />
                    ) : (
                      initials(p.label)
                    )}
                  </span>
                  <div>
                    <strong>{p.label}</strong>
                    <small>
                      {p.version ? `v${p.version} · ` : ''}
                      {p.kind === 'acp' ? 'ACP agent · ' : ''}
                      {STATUS_TEXT[p.status]}
                    </small>
                  </div>
                  {p.status === 'ready' && <Check size={16} className="wizard-tick" />}
                </div>
              ))}
            </div>
            <div className="wizard-card">
              <div className="wizard-row">
                <span className="wizard-icon">
                  <Server size={18} />
                </span>
                <div>
                  <strong>Add a remote host</strong>
                  <small>Another computer on your tailnet. You can do this later.</small>
                </div>
                <button className="wizard-small" onClick={() => setHostsOpen(true)}>
                  Add host
                </button>
              </div>
            </div>
            {connected && readyAgents.length === 0 && (
              <p className="wizard-note">
                No agent is ready yet. Install one such as Claude Code, Codex or Grok and sign in,
                then scan again — or continue and set it up in Settings.
              </p>
            )}
            <Button variant="app" className="wizard-primary" disabled={!connected} onClick={next}>
              Continue
            </Button>
          </>
        )}

        {step === 3 && (
          <>
            <StepHead
              step={step}
              title="Add a folder to work in"
              lead="Pick the repositories your agents can work on. You can add more at any time."
            />
            <button
              className="wizard-drop"
              disabled={!connected || picking}
              onClick={() => void chooseFolder(hostKey)}
            >
              {picking ? <Loader2 size={22} className="fb-spin" /> : <FolderOpen size={22} />}
              <strong>
                {picking && native ? 'Waiting for the folder picker…' : 'Choose a folder…'}
              </strong>
              <small>
                {native ? "Opens your system's folder picker" : `Browse the folders on ${hostName}`}
              </small>
            </button>
            {projects.length > 0 && (
              <>
                <div className="wizard-label">
                  <span>Added</span>
                </div>
                <div className="wizard-card">
                  {projects.slice(-4).map((p) => (
                    <div className="wizard-row" key={p.path}>
                      <span className="wizard-icon">
                        <FolderOpen size={16} />
                      </span>
                      <div>
                        <strong>{p.name}</strong>
                        <small className="mono">{p.path}</small>
                      </div>
                      <Check size={16} className="wizard-tick" />
                    </div>
                  ))}
                </div>
              </>
            )}
            <Button variant="app" className="wizard-primary" onClick={next}>
              {projects.length > 0 ? 'Continue' : 'Skip for now'}
            </Button>
          </>
        )}

        {step === 4 && (
          <>
            <StepHead
              step={step}
              title="How much should agents ask first?"
              lead="You can change this per session, or any time in Settings."
            />
            {agent && modes.length > 0 ? (
              <div className="wizard-options" role="radiogroup" aria-label="Permission mode">
                {modes.map((mode, i) => (
                  <button
                    key={mode.id}
                    role="radio"
                    aria-checked={chosenMode === mode.id}
                    className={`wizard-option ${chosenMode === mode.id ? 'selected' : ''}`}
                    onClick={() => setAgentDefaults(hostId, agent.id, { permissionMode: mode.id })}
                  >
                    <span>
                      <strong>
                        {mode.label}
                        {i === 0 && <em>Recommended</em>}
                        {mode.dangerous && <em className="danger">Full access</em>}
                      </strong>
                      {mode.description && <small>{mode.description}</small>}
                    </span>
                    <span className="wizard-radio" />
                  </button>
                ))}
              </div>
            ) : (
              <p className="wizard-note">
                {agent
                  ? `${agent.label} reports its approval choices when a session starts; pick them in the composer.`
                  : 'No agent is ready yet, so there is nothing to choose here. Settings has this later.'}
              </p>
            )}
            {readyAgents.length > 1 && (
              <div className="wizard-card">
                <div className="wizard-row">
                  <div>
                    <strong>Default agent</strong>
                    <small>Used for new sessions</small>
                  </div>
                  <Select
                    aria-label="Default agent"
                    value={agent?.id ?? ''}
                    onChange={(e) => setDefaultAgent(hostId, e.target.value || undefined)}
                  >
                    {readyAgents.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </Select>
                </div>
              </div>
            )}
            <Button variant="app" className="wizard-primary" onClick={next}>
              Continue
            </Button>
          </>
        )}

        {step === 5 && (
          <>
            <StepHead
              step={step}
              title="You're all set"
              lead="Here is what we set up. Start a session with any of your agents whenever you are ready."
            />
            <div className="wizard-card">
              <SummaryRow ok={connected} label="Host" value={hostName} />
              <SummaryRow
                ok={readyAgents.length > 0}
                label="Agents"
                value={readyAgents.map((p) => p.label).join(', ') || 'None ready yet'}
              />
              <SummaryRow
                ok={projects.length > 0}
                label="Folders"
                value={projects.map((p) => p.name).join(', ') || 'None yet'}
              />
              <SummaryRow
                ok={!!modeLabel}
                label="Permissions"
                value={modeLabel ?? 'Agent default'}
              />
            </div>
            <div className="wizard-card">
              <div className="wizard-row">
                <div>
                  <strong>Notify me when an agent needs me</strong>
                  <small>Desktop notifications for permission requests and questions</small>
                </div>
                <Switch
                  aria-label="Notify me when an agent needs me"
                  checked={notify.values.needsYou}
                  onCheckedChange={(on) => void setNotify(on)}
                />
              </div>
            </div>
            <Button variant="app" className="wizard-primary" onClick={finish}>
              Start your first session
            </Button>
          </>
        )}
      </div>

      {step > 1 && (
        <footer className="wizard-foot">
          <button className="wizard-back" onClick={back}>
            <ArrowLeft size={14} /> Back
          </button>
          <div className="wizard-progress" aria-hidden>
            {Array.from({ length: STEPS }, (_, i) => (
              <span key={i} className={i < step ? 'done' : ''} />
            ))}
          </div>
          <button className="wizard-back" onClick={onSkip}>
            Skip setup
          </button>
        </footer>
      )}
      {hostsOpen && <HostsDialog onClose={() => setHostsOpen(false)} />}
    </main>
  )
}

function StepHead({ step, title, lead }: { step: number; title: string; lead: string }) {
  return (
    <header className="wizard-head">
      <span>
        Step {step} of {STEPS}
      </span>
      <h1>{title}</h1>
      <p className="wizard-lead">{lead}</p>
    </header>
  )
}

function SummaryRow({ ok, label, value }: { ok: boolean; label: string; value: string }) {
  return (
    <div className="wizard-row summary">
      <Check size={16} className={ok ? 'wizard-tick' : 'wizard-tick off'} />
      <span className="wizard-summary-label">{label}</span>
      <span className="wizard-summary-value">{value}</span>
    </div>
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
