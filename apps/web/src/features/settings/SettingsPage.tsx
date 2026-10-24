import { useEffect, useState } from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { Group, Panel, Separator, useDefaultLayout } from 'react-resizable-panels'
import {
  ArrowLeft,
  Bell,
  BellRing,
  CalendarClock,
  ChartPie,
  Code2,
  GitBranch,
  Info,
  Keyboard,
  Monitor,
  Palette,
  Search,
  Server,
  Shield,
  SlidersHorizontal,
  Sparkles,
  Wrench,
} from 'lucide-react'
import { useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { HostsDialog, type HostDialogView } from '../hosts/HostsDialog.tsx'
import { HostsOverview } from '../hosts/HostsOverview.tsx'
import { AgentsSettings } from './AgentsSettings.tsx'
import { PreferencesSettings } from './PreferencesSettings.tsx'
import { PermissionsSettings } from './PermissionsSettings.tsx'
import { ToolsSettings } from './ToolsSettings.tsx'
import { NotificationsSettings } from './NotificationsSettings.tsx'
import { UsageSettings } from './UsageSettings.tsx'
import { SchedulesSettings } from './SchedulesSettings.tsx'
import { AlertsSettings } from './AlertsSettings.tsx'
import './settings.css'
import { Select } from '../../ui/Select.tsx'
import { Logo } from '../../ui/Logo.tsx'

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'shortcuts'
  | 'agents'
  | 'permissions'
  | 'tools'
  | 'schedules'
  | 'alerts'
  | 'hosts'
  | 'git'
  | 'editor'
  | 'usage'
  | 'about'
const SECTIONS = [
  { id: 'general', label: 'General', group: 'App', icon: SlidersHorizontal },
  { id: 'appearance', label: 'Appearance', group: 'App', icon: Palette },
  { id: 'notifications', label: 'Notifications', group: 'App', icon: Bell },
  { id: 'shortcuts', label: 'Shortcuts', group: 'App', icon: Keyboard },
  { id: 'agents', label: 'Agents', group: 'Agents', icon: Sparkles },
  { id: 'permissions', label: 'Permissions', group: 'Agents', icon: Shield },
  { id: 'tools', label: 'Tools & MCP', group: 'Agents', icon: Wrench },
  { id: 'schedules', label: 'Schedules', group: 'Automation', icon: CalendarClock },
  { id: 'alerts', label: 'Phone alerts', group: 'Automation', icon: BellRing },
  { id: 'hosts', label: 'Hosts', group: 'Workspace', icon: Server },
  { id: 'git', label: 'Git', group: 'Workspace', icon: GitBranch },
  { id: 'editor', label: 'Editor', group: 'Workspace', icon: Code2 },
  { id: 'usage', label: 'Usage', group: 'Account', icon: ChartPie },
  { id: 'about', label: 'About', group: 'Account', icon: Info },
] as const

export function parseSettingsSection(value: unknown): SettingsSection | undefined {
  return SECTIONS.find((section) => section.id === value)?.id
}

export function SettingsPage({ section }: { section: SettingsSection }) {
  const layout = useDefaultLayout({ id: 'beddcode-settings', storage: settingsLayoutStorage() })
  const navigate = useNavigate()
  const [search, setSearch] = useState('')
  const [hostKey, setHostKey] = useState(LOCAL_HOST_KEY)
  const [hostsOpen, setHostsOpen] = useState<HostDialogView | null>(null)
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const selectedHost = entries.some((e) => e.key === hostKey) ? hostKey : LOCAL_HOST_KEY
  // Escape leaves Settings, unless something on the page is using it (a dialog, a text field).
  useEffect(() => {
    if (hostsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      const target = e.target instanceof Element ? e.target : null
      if (
        target?.closest(
          'input, textarea, select, [role="dialog"], [role="menu"], [aria-haspopup][aria-expanded="true"]',
        )
      )
        return
      void navigate({ to: '/' })
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [hostsOpen, navigate])
  const sections = SECTIONS.filter((s) => s.label.toLowerCase().includes(search.toLowerCase()))

  return (
    <Group
      orientation="horizontal"
      className="settings-shell"
      defaultLayout={layout.defaultLayout}
      onLayoutChanged={layout.onLayoutChanged}
    >
      <Panel
        id="settings-navigation"
        className="settings-navigation-panel"
        defaultSize="234px"
        minSize="160px"
        maxSize="400px"
        groupResizeBehavior="preserve-pixel-size"
      >
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
            <Logo size={28} />
            <div>
              BeddCode<small>Development build</small>
            </div>
          </div>
        </aside>
      </Panel>
      <Separator className="shell-sep settings-separator" aria-label="Resize settings navigation" />
      <Panel id="settings-content" className="settings-content-panel" minSize="220px">
        <main className="panel settings-main">
          <div className="settings-content">
            {(['general', 'appearance', 'shortcuts', 'git', 'editor'] as const).map((page) =>
              section === page ? <PreferencesSettings key={page} section={page} /> : null,
            )}
            {(section === 'agents' ||
              section === 'permissions' ||
              section === 'tools' ||
              section === 'schedules' ||
              section === 'alerts' ||
              section === 'usage') && (
              <>
                <header className="settings-heading">
                  <h2>
                    {section === 'permissions'
                      ? 'Permissions'
                      : section === 'schedules'
                        ? 'Schedules'
                        : section === 'alerts'
                          ? 'Phone alerts'
                          : section === 'tools'
                            ? 'Tools & MCP'
                            : section === 'usage'
                              ? 'Usage'
                              : 'Agents'}
                  </h2>
                  <p>
                    {section === 'permissions'
                      ? 'Choose what each agent may do without asking.'
                      : section === 'schedules'
                        ? 'Prompts the host sends on a timer, even with every app closed.'
                        : section === 'alerts'
                          ? 'Alerts the host sends to your phone when an agent finishes or needs you.'
                          : section === 'tools'
                            ? 'MCP servers your agents can use, as each agent keeps them.'
                            : section === 'usage'
                              ? 'What your plans have used, and where it went.'
                              : 'Which coding agents BeddCode can run, and how they behave in new sessions.'}
                  </p>
                </header>
                {entries.length > 1 && (
                  <label className="settings-host">
                    <Monitor size={16} />
                    <span>
                      {section === 'usage'
                        ? 'Usage on'
                        : section === 'schedules' || section === 'alerts'
                          ? 'Host'
                          : 'Agents on'}
                    </span>
                    <Select
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
                    </Select>
                  </label>
                )}
                {section === 'agents' ? (
                  <AgentsSettings key={selectedHost} hostKey={selectedHost} />
                ) : section === 'tools' ? (
                  <ToolsSettings key={selectedHost} hostKey={selectedHost} />
                ) : section === 'schedules' ? (
                  <SchedulesSettings key={selectedHost} hostKey={selectedHost} />
                ) : section === 'alerts' ? (
                  <AlertsSettings key={selectedHost} hostKey={selectedHost} />
                ) : section === 'usage' ? (
                  <UsageSettings key={selectedHost} hostKey={selectedHost} />
                ) : (
                  <PermissionsSettings key={selectedHost} hostKey={selectedHost} />
                )}
              </>
            )}
            {section === 'notifications' && <NotificationsSettings />}
            {section === 'hosts' && (
              <HostsOverview
                onAdd={() => setHostsOpen('add')}
                onShare={() => setHostsOpen('share')}
                onDevices={() => setHostsOpen('devices')}
              />
            )}
            {section === 'about' && (
              <>
                <header className="settings-heading">
                  <Logo size={48} className="about-logo" />
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
                        Agent logins, project files, and session history belong to the machine
                        running the session.
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
      </Panel>
      {hostsOpen && <HostsDialog initialView={hostsOpen} onClose={() => setHostsOpen(null)} />}
    </Group>
  )
}

function settingsLayoutStorage(): Storage | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}
