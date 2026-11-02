import { useEffect, useState, type ReactNode } from 'react'
import { Check, ChevronLeft, LoaderCircle, LogOut, RefreshCw, X } from 'lucide-react'
import type { LinearClient, Team } from '@linear/sdk'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { hostRequest } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { Select } from '../../ui/Select.tsx'
import { readDefaults, writeDefaults, type Defaults } from './linearPrefs.ts'
import '../schedules/schedules.css'

interface Props {
  client: LinearClient
  org: string
  name: string
  email: string
  apiKey: string
  teams: Team[]
  accounts: { id: string; label: string }[]
  activeId: string
  /** The form that adds another account. */
  keyForm: ReactNode
  onSelectAccount(id: string): void
  onRemove(): void
  onClose(): void
}

const mask = (key: string) => `${key.slice(0, 8)}${'•'.repeat(18)}${key.slice(-4)}`

const GRANTS: [boolean, string][] = [
  [true, 'Read issues, projects and cycles'],
  [true, 'Create and update issues'],
  [true, 'Write comments'],
  [false, 'Manage members or billing'],
]

/** The Linear connection: who is signed in, what new issues start with, what the host does for you. */
export function LinearConnection({
  client,
  org,
  name,
  email,
  apiKey,
  teams,
  accounts,
  activeId,
  keyForm,
  onSelectAccount,
  onRemove,
  onClose,
}: Props) {
  const [defaults, setDefaults] = useState<Defaults>(() => {
    const saved = readDefaults()
    return { ...saved, teamId: saved.teamId || (teams[0]?.id ?? '') }
  })
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([])
  const [test, setTest] = useState<{ state: 'idle' | 'busy' | 'ok' | 'bad'; text?: string }>({
    state: 'idle',
  })
  const [checkedAt, setCheckedAt] = useState(() => new Date())
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  const set = (patch: Partial<Defaults>) => setDefaults((d) => ({ ...d, ...patch }))

  // The team's projects, for the default project.
  useEffect(() => {
    if (!defaults.teamId) return setProjects([])
    let current = true
    void client
      .team(defaults.teamId)
      .then((team) => team.projects({ first: 100 }))
      .then(
        (list) => current && setProjects(list.nodes.map((p) => ({ id: p.id, name: p.name }))),
        () => current && setProjects([]),
      )
    return () => {
      current = false
    }
  }, [client, defaults.teamId])

  const testAgain = async () => {
    setTest({ state: 'busy' })
    try {
      const me = await client.viewer
      setTest({ state: 'ok', text: `Signed in as ${me.displayName} · ${org} workspace` })
    } catch (err) {
      setTest({ state: 'bad', text: err instanceof Error ? err.message : String(err) })
    }
    setCheckedAt(new Date())
  }

  const save = async () => {
    setSaving(true)
    setError(undefined)
    try {
      const sync = await hostRequest(LOCAL_HOST_KEY, 'linear.setSync', {
        fileFailedRuns: defaults.fileFailedRuns && defaults.teamId !== '',
        teamId: defaults.teamId || undefined,
      })
      writeDefaults({ ...defaults, fileFailedRuns: sync.fileFailedRuns })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="lin-connection">
      <button type="button" className="sch-back" onClick={onClose}>
        <ChevronLeft size={14} /> Linear
      </button>
      <header className="sch-head">
        <div>
          <h2>Connect Linear</h2>
          <p>Link your Linear account so agents can read, file and update issues for you.</p>
        </div>
      </header>

      <div className="sch-editor-grid">
        <div className="sch-editor-main">
          <h3 className="sch-group">Authentication</h3>
          <section className="sch-card">
            <div className="sch-field">
              <span>Personal API key</span>
              <input readOnly className="mono" value={mask(apiKey)} aria-label="API key" />
              <small className="sch-muted">
                Stored on this device; the host keeps a copy for agents.
              </small>
            </div>
            <div className={`lin-test ${test.state}`} role="status">
              {test.state === 'busy' ? (
                <LoaderCircle size={15} />
              ) : test.state === 'bad' ? (
                <X size={15} />
              ) : (
                <Check size={15} />
              )}
              <span>
                <strong>{test.state === 'bad' ? 'Connection failed' : 'Connection works'}</strong>
                <small>{test.text ?? `Signed in as ${name} · ${org} workspace`}</small>
              </span>
              <Button
                variant="app"
                type="button"
                className="settings-button"
                onClick={() => void testAgain()}
                disabled={test.state === 'busy'}
              >
                <RefreshCw size={13} /> Test again
              </Button>
            </div>
            {accounts.length > 1 && (
              <div className="sch-field">
                <span>Active account</span>
                <Select
                  aria-label="Linear account"
                  value={activeId}
                  onChange={(e) => onSelectAccount(e.target.value)}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label}
                    </option>
                  ))}
                </Select>
              </div>
            )}
            <div className="sch-field">
              <span>Add another account</span>
              {keyForm}
            </div>
          </section>

          <h3 className="sch-group">Defaults for new issues</h3>
          <section className="sch-card">
            <div className="sch-two">
              <div className="sch-field">
                <span>Workspace</span>
                <input readOnly value={org} aria-label="Workspace" />
              </div>
              <div className="sch-field">
                <span>Team</span>
                <Select
                  aria-label="Default team"
                  value={defaults.teamId}
                  onChange={(e) => set({ teamId: e.target.value, projectId: '' })}
                >
                  {teams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
            <div className="sch-two">
              <div className="sch-field">
                <span>Project</span>
                <Select
                  aria-label="Default project"
                  value={defaults.projectId}
                  onChange={(e) => set({ projectId: e.target.value })}
                >
                  <option value="">No project</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="sch-field">
                <span>Assignee</span>
                <Select
                  aria-label="Default assignee"
                  value={defaults.assignee}
                  onChange={(e) => set({ assignee: e.target.value as Defaults['assignee'] })}
                >
                  <option value="me">Me ({name})</option>
                  <option value="none">Unassigned</option>
                </Select>
              </div>
            </div>
          </section>

          <h3 className="sch-group">Sync</h3>
          <section className="sch-card">
            <div className="sch-toggle-row lin-first-row">
              <span>
                <strong>File an issue when a scheduled task fails</strong>
                <small>
                  Adds the error and when it ran, in the default team above. Done by the host, even
                  with every app closed.
                </small>
              </span>
              <Switch
                aria-label="File an issue when a scheduled task fails"
                checked={defaults.fileFailedRuns}
                disabled={!defaults.teamId}
                onCheckedChange={(fileFailedRuns) => set({ fileFailedRuns })}
              />
            </div>
          </section>
        </div>

        <aside className="sch-editor-side">
          <section className="sch-card lin-conn-card">
            <span className="sch-eyebrow">Connection</span>
            <span className="lin-status ok">
              <i />
              Connected
            </span>
            <dl className="sch-facts">
              <div>
                <dt>Workspace</dt>
                <dd>{org}</dd>
              </div>
              <div>
                <dt>Account</dt>
                <dd>{name}</dd>
              </div>
              <div>
                <dt>Email</dt>
                <dd>{email}</dd>
              </div>
              <div>
                <dt>API key</dt>
                <dd className="mono">…{apiKey.slice(-4)}</dd>
              </div>
              <div>
                <dt>Teams</dt>
                <dd>{teams.length}</dd>
              </div>
              <div>
                <dt>Last checked</dt>
                <dd>{checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</dd>
              </div>
            </dl>
            <Button
              variant="app"
              type="button"
              className="settings-button danger"
              onClick={onRemove}
            >
              <LogOut size={13} /> Disconnect
            </Button>
          </section>
          <section className="sch-card">
            <span className="sch-eyebrow">What this key lets BeddCode do</span>
            <ul className="lin-grants">
              {GRANTS.map(([yes, text]) => (
                <li key={text} className={yes ? '' : 'no'}>
                  {yes ? <Check size={14} /> : <X size={14} />}
                  {text}
                </li>
              ))}
            </ul>
          </section>
        </aside>
      </div>

      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <footer className="sch-foot">
        <span />
        <span className="sch-foot-actions">
          <Button variant="app" type="button" className="settings-button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="app"
            type="button"
            className="settings-button primary"
            disabled={saving}
            onClick={() => void save()}
          >
            <Check size={13} /> {saving ? 'Saving…' : 'Save connection'}
          </Button>
        </span>
      </footer>
    </div>
  )
}
