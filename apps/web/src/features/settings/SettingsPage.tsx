import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import {
  ArrowLeft,
  Code2,
  GitBranch,
  Info,
  Keyboard,
  Monitor,
  Palette,
  Plus,
  Search,
  Server,
  Shield,
  SlidersHorizontal,
  Sparkles,
} from 'lucide-react'
import { useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { HostsDialog } from '../hosts/HostsDialog.tsx'
import { AgentsSettings } from './AgentsSettings.tsx'
import { PreferencesSettings } from './PreferencesSettings.tsx'
import { PermissionsSettings } from './PermissionsSettings.tsx'
import { useAppPreferences } from '../../stores/appPreferences.ts'
import './settings.css'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'shortcuts'
  | 'agents'
  | 'permissions'
  | 'hosts'
  | 'git'
  | 'editor'
  | 'about'
const SECTIONS = [
  { id: 'general', label: 'General', group: 'App', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', group: 'App', icon: Palette },
  { id: 'shortcuts', label: 'Shortcuts', group: 'App', icon: Keyboard },
  { id: 'agents', label: 'Agents', group: 'Agents', icon: Sparkles },
  { id: 'permissions', label: 'Permissions', group: 'Agents', icon: Shield },
  { id: 'hosts', label: 'Hosts', group: 'Workspace', icon: Server },
  { id: 'git', label: 'Git', group: 'Workspace', icon: GitBranch },
  { id: 'editor', label: 'Editor', group: 'Workspace', icon: Code2 },
  { id: 'about', label: 'About', group: 'Account', icon: Info },
] as const

export function parseSettingsSection(value: unknown): SettingsSection | undefined {
  return SECTIONS.find((section) => section.id === value)?.id
}

export function SettingsPage({ section }: { section: SettingsSection }) {
  const [search, setSearch] = useState('')
  const [hostKey, setHostKey] = useState(LOCAL_HOST_KEY)
  const [hostsOpen, setHostsOpen] = useState(false)
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const defaultHostKey = useAppPreferences((s) => s.values.defaultHostKey)
  const updatePreferences = useAppPreferences((s) => s.update)
  const selectedHost = entries.some((e) => e.key === hostKey) ? hostKey : LOCAL_HOST_KEY
  const sections = SECTIONS.filter((s) => s.label.toLowerCase().includes(search.toLowerCase()))

  return (
    <div className="settings-shell">
      <aside className="panel settings-nav">
        <div className="settings-nav-head">
          <h1>Settings</h1>
          <Link
            to="/"
            className="icon-btn"
            aria-label="Back to workspace"
            title="Back to workspace"
          >
            <ArrowLeft size={17} />
          </Link>
        </div>
        <label className="settings-search">
          <Search size={16} />
          <input
            aria-label="Search settings"
            placeholder="Search settings"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <nav aria-label="Settings">
          {sections.map(({ id, label, group, icon: Icon }, index) => (
            <div key={id}>
              {sections[index - 1]?.group !== group && (
                <div className="settings-nav-group">{group}</div>
              )}
              <Link
                to="/settings"
                search={{ section: id }}
                className={`settings-nav-link ${section === id ? 'selected' : ''}`}
                aria-current={section === id ? 'page' : undefined}
              >
                <Icon size={18} /> {label}
              </Link>
            </div>
          ))}
          {sections.length === 0 && <p className="muted">No matching settings.</p>}
        </nav>
        <div className="settings-nav-foot">
          <span className="avatar">B</span>
          <div>
            BeddCode<small>Development build</small>
          </div>
        </div>
      </aside>
      <main className="panel settings-main">
        <div className="settings-content">
          {(['general', 'appearance', 'shortcuts', 'git', 'editor'] as const).map((page) =>
            section === page ? <PreferencesSettings key={page} section={page} /> : null,
          )}
          {(section === 'agents' || section === 'permissions') && (
            <>
              <header className="settings-heading">
                <h2>{section === 'permissions' ? 'Permissions' : 'Agents'}</h2>
                <p>
                  {section === 'permissions'
                    ? 'Choose what each agent may do without asking.'
                    : 'Which coding agents BeddCode can run, and how they behave in new sessions.'}
                </p>
              </header>
              {entries.length > 1 && (
                <label className="settings-host">
                  <Monitor size={16} />
                  <span>Agents on</span>
                  <select
                    aria-label="Settings host"
                    value={selectedHost}
                    onChange={(e) => setHostKey(e.target.value)}
                  >
                    {entries.map((entry) => (
                      <option key={entry.key} value={entry.key}>
                        {entry.key === LOCAL_HOST_KEY
                          ? 'This PC'
                          : (runtimes[entry.key]?.host?.name ?? entry.name)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {section === 'agents' ? (
                <AgentsSettings key={selectedHost} hostKey={selectedHost} />
              ) : (
                <PermissionsSettings key={selectedHost} hostKey={selectedHost} />
              )}
            </>
          )}
          {section === 'hosts' && (
            <>
              <header className="settings-heading">
                <h2>Hosts</h2>
                <p>
                  Machines where agents can run. Sessions stay on their host when you close the app.
                </p>
              </header>
              <div className="settings-section-head">
                <h3>Connected hosts</h3>
                <button className="settings-button" onClick={() => setHostsOpen(true)}>
                  <Plus size={13} /> Add host
                </button>
              </div>
              <div className="settings-card">
                {entries.map((entry) => (
                  <div className="setting-row" key={entry.key}>
                    <span className="host-avatar">
                      {entry.key === LOCAL_HOST_KEY ? <Monitor size={17} /> : <Server size={17} />}
                    </span>
                    <div className="setting-label">
                      <span>
                        {entry.key === LOCAL_HOST_KEY
                          ? 'This PC'
                          : (runtimes[entry.key]?.host?.name ?? entry.name)}
                      </span>
                      <small>
                        {entry.key === LOCAL_HOST_KEY
                          ? 'Local'
                          : entry.routes[0]?.replace(/^wss?:\/\/|\/ws$/g, '')}{' '}
                        ·{' '}
                        {runtimes[entry.key]?.host?.platform === 'win32'
                          ? 'Windows'
                          : runtimes[entry.key]?.host?.platform === 'linux'
                            ? 'Linux'
                            : 'Host'}{' '}
                        · {runtimes[entry.key]?.replica.order.length ?? 0} sessions
                      </small>
                    </div>
                    <span className="agent-status">
                      <span
                        className={`dot ${runtimes[entry.key]?.connection === 'connected' ? 'ok' : 'warn'}`}
                      />
                      {runtimes[entry.key]?.connection === 'connected'
                        ? 'Connected'
                        : runtimes[entry.key]?.connection === 'connecting'
                          ? 'Connecting…'
                          : runtimes[entry.key]?.connection === 'reconnecting'
                            ? 'Reconnecting…'
                            : runtimes[entry.key]?.connection === 'denied'
                              ? 'Pair again'
                              : 'Offline'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="settings-section-head">
                <h3>Connection</h3>
              </div>
              <div className="settings-card">
                <div className="setting-row">
                  <label className="setting-label" htmlFor="hosts-default-host">
                    <span>Default host</span>
                    <small>Where new sessions start.</small>
                  </label>
                  <select
                    id="hosts-default-host"
                    aria-label="Default host"
                    value={
                      entries.some((entry) => entry.key === defaultHostKey)
                        ? defaultHostKey
                        : LOCAL_HOST_KEY
                    }
                    onChange={(event) => updatePreferences({ defaultHostKey: event.target.value })}
                  >
                    {entries.map((entry) => (
                      <option key={entry.key} value={entry.key}>
                        {entry.key === LOCAL_HOST_KEY
                          ? 'This PC'
                          : (runtimes[entry.key]?.host?.name ?? entry.name)}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="setting-row">
                  <div className="setting-label">
                    <span>Reconnect on launch</span>
                    <small>BeddCode reconnects to every saved host automatically.</small>
                  </div>
                  <span className="settings-value">Always on</span>
                </div>
              </div>
              <button className="settings-button" onClick={() => setHostsOpen(true)}>
                Manage hosts and pairing
              </button>
            </>
          )}
          {section === 'about' && (
            <>
              <header className="settings-heading">
                <h2>About BeddCode</h2>
                <p>A workspace for your coding agents, projects, and machines.</p>
              </header>
              <div className="settings-card">
                <div className="setting-row">
                  <div className="setting-label">
                    <span>Build</span>
                    <small>Development build · Windows and Linux</small>
                  </div>
                </div>
                <div className="setting-row">
                  <div className="setting-label">
                    <span>Your data stays on each host</span>
                    <small>
                      Agent logins, project files, and session history belong to the machine running
                      the session.
                    </small>
                  </div>
                </div>
                <div className="setting-row">
                  <div className="setting-label">
                    <span>Agent settings</span>
                    <small>
                      Saved defaults apply to new sessions in this app. Agent CLIs keep their own
                      login and configuration.
                    </small>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </main>
      {hostsOpen && <HostsDialog onClose={() => setHostsOpen(false)} />}
    </div>
  )
}
