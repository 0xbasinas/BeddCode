import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Plus, RefreshCw, Shield, Trash2 } from 'lucide-react'
import type { McpServer, McpServerPolicy } from '@beddcode/contracts'
import { Select } from '../../ui/Select.tsx'
import { hostRequest, useRuntime } from '../../stores/host.ts'
import { emptyMcpForm, mcpInputFromForm, type McpForm } from './mcpForm.ts'
import { AddMcpDialog } from './AddMcpDialog.tsx'
import { AllMcpServers } from './AllMcpServers.tsx'

const STATUS: Record<McpServer['status'], string> = {
  connected: 'Connected',
  failed: 'Failed to connect',
  'needs-auth': 'Needs sign-in',
  disabled: 'Disabled',
  pending: 'Connecting…',
  unknown: 'Configured',
}

/**
 * MCP servers as each agent's own CLI keeps them. Adding or removing one runs the CLI's own command,
 * so the same servers are there when you use the agent outside BeddCode.
 */
export function ToolsSettings({ hostKey }: { hostKey: string }) {
  const { providers, connection, projects } = useRuntime(hostKey)
  const online = connection === 'connected'
  const agents = providers.filter((p) => p.status === 'ready' && p.capabilities.mcp === true)
  const [instanceId, setInstanceId] = useState<string>()
  const current = agents.find((a) => a.id === instanceId) ?? agents[0]
  const [servers, setServers] = useState<McpServer[] | null>(null)
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)
  const [form, setForm] = useState<McpForm>(emptyMcpForm())
  const [removing, setRemoving] = useState<McpServer>()
  // MCP policies are per project; the server list is read in that project's folder.
  const [policyProject, setPolicyProject] = useState<string>()
  const project = projects.find((p) => p.path === policyProject) ?? projects[0]
  const [policyFor, setPolicyFor] = useState<string>()
  const [policyForm, setPolicyForm] = useState({ enabled: true, allow: '', deny: '' })

  const load = useCallback(async () => {
    if (!current || !online) return
    setServers(null)
    setError(undefined)
    try {
      setServers(
        await hostRequest(hostKey, 'mcp.list', { instanceId: current.id, cwd: project?.path }),
      )
    } catch (err) {
      setServers([])
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [hostKey, current?.id, online, project?.path])
  useEffect(() => void load(), [load])

  const openPolicy = (server: McpServer) => {
    setPolicyFor(server.name)
    const p = server.policy
    setPolicyForm({
      enabled: p?.enabled !== false,
      allow: p?.toolsAllow?.join(', ') ?? '',
      deny: p?.toolsDeny?.join(', ') ?? '',
    })
  }

  const savePolicy = async (name: string) => {
    if (!project) return setError('Add a project first: policies are per project folder.')
    const list = (v: string) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    const policy: McpServerPolicy = {
      enabled: policyForm.enabled,
      ...(list(policyForm.allow).length ? { toolsAllow: list(policyForm.allow) } : {}),
      ...(list(policyForm.deny).length ? { toolsDeny: list(policyForm.deny) } : {}),
    }
    const had = servers?.find((s) => s.name === name)?.policy
    const clearing =
      had && policyForm.enabled && !list(policyForm.allow).length && !list(policyForm.deny).length
    const ok = await run(() =>
      hostRequest(hostKey, 'mcp.policy.set', {
        cwd: project.path,
        name,
        policy: clearing ? null : policy,
      }),
    )
    if (ok) setPolicyFor(undefined)
  }

  const run = async (action: () => Promise<unknown>) => {
    setBusy(true)
    setError(undefined)
    try {
      await action()
      await load()
      return true
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    let server
    try {
      server = mcpInputFromForm({
        ...form,
        scope: current?.kind === 'claude' ? form.scope : undefined,
      })
    } catch (err) {
      return setError(err instanceof Error ? err.message : String(err))
    }
    const ok = await run(() => hostRequest(hostKey, 'mcp.add', { instanceId: current!.id, server }))
    if (ok) {
      setAdding(false)
      setForm(emptyMcpForm())
    }
  }

  return (
    <>
      {!online && (
        <p className="settings-notice" role="status">
          This host is offline. Reconnect to manage its tools.
        </p>
      )}
      {agents.length === 0 && online && (
        <p className="settings-empty">
          None of the agents on this host have MCP settings BeddCode can manage.
        </p>
      )}
      {agents.length > 0 && (
        <>
          <AllMcpServers hostKey={hostKey} online={online} />
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-label">
                <label htmlFor="mcp-agent">Agent</label>
                <small>
                  Servers live in the agent&apos;s own configuration, so they are the same in its
                  own CLI.
                </small>
              </div>
              <Select
                id="mcp-agent"
                value={current?.id}
                onChange={(e) => setInstanceId(e.target.value)}
              >
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.label}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div className="settings-section-head">
            <h3>MCP servers</h3>
            <div className="settings-actions">
              {projects.length > 0 && (
                <Select
                  aria-label="Project for server policies"
                  value={project?.path}
                  onChange={(e) => setPolicyProject(e.target.value)}
                >
                  {projects.map((p) => (
                    <option key={p.path} value={p.path}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              )}
              <Button
                variant="app"
                className="settings-button"
                disabled={!online || busy}
                onClick={() => void load()}
              >
                <RefreshCw size={14} /> Refresh
              </Button>
              <Button
                variant="app"
                className="settings-button"
                disabled={!online || busy}
                onClick={() => {
                  setAdding(true)
                  setError(undefined)
                }}
              >
                <Plus size={14} /> Add server
              </Button>
            </div>
          </div>

          {error && !adding && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}

          {adding && current && (
            <AddMcpDialog
              hostKey={hostKey}
              agent={current.label}
              kind={current.kind}
              form={form}
              setForm={setForm}
              busy={busy}
              error={error}
              onAdd={() => void add()}
              onClose={() => {
                setAdding(false)
                setError(undefined)
                setForm(emptyMcpForm())
              }}
            />
          )}

          <div className="settings-card">
            {servers === null && online && <p className="settings-empty">Checking servers…</p>}
            {servers?.length === 0 && !error && (
              <p className="settings-empty">No MCP servers yet.</p>
            )}
            {servers?.map((server) => (
              <div className="setting-row mcp-row" key={`${server.scope ?? ''}:${server.name}`}>
                <div className="setting-label">
                  <span>
                    {server.name}
                    {server.scope && <span className="settings-badge">{server.scope}</span>}
                    {server.policy && (
                      <span
                        className="settings-badge"
                        title="This project has a policy for this server"
                      >
                        policy
                      </span>
                    )}
                  </span>
                  <small title={server.target}>{server.target}</small>
                  {server.error && <small className="mcp-error">{server.error}</small>}
                </div>
                <span className="agent-status">
                  <span
                    className={`dot ${server.status === 'connected' ? 'ok' : server.status === 'unknown' ? '' : 'warn'}`}
                  />
                  {STATUS[server.status]}
                </span>
                <Button
                  variant="app"
                  className="icon-btn"
                  aria-label={`Policy for ${server.name}`}
                  title="Project policy: switch off, allow or deny tools"
                  disabled={!online || busy}
                  onClick={() =>
                    policyFor === server.name ? setPolicyFor(undefined) : openPolicy(server)
                  }
                >
                  <Shield size={14} />
                </Button>
                <Button
                  variant="app"
                  className="icon-btn"
                  aria-label={`Remove ${server.name}`}
                  disabled={!online || busy}
                  onClick={() => setRemoving(server)}
                >
                  <Trash2 size={14} />
                </Button>
                {policyFor === server.name && (
                  <div className="mcp-policy-editor">
                    <p>
                      These settings apply to BeddCode's server test and tool listing. They do not
                      restrict MCP tools used directly by an agent.
                    </p>
                    <label className="setting-row">
                      <span>Enabled for this project</span>
                      <input
                        type="checkbox"
                        checked={policyForm.enabled}
                        onChange={(e) =>
                          setPolicyForm({ ...policyForm, enabled: e.target.checked })
                        }
                      />
                    </label>
                    <label className="setting-row">
                      <span>Allow only these tools (comma separated, empty = all)</span>
                      <input
                        value={policyForm.allow}
                        placeholder="read, search"
                        onChange={(e) => setPolicyForm({ ...policyForm, allow: e.target.value })}
                      />
                    </label>
                    <label className="setting-row">
                      <span>Always deny these tools</span>
                      <input
                        value={policyForm.deny}
                        placeholder="delete, exec"
                        onChange={(e) => setPolicyForm({ ...policyForm, deny: e.target.value })}
                      />
                    </label>
                    <div className="settings-actions">
                      <Button
                        variant="app"
                        className="settings-button"
                        disabled={!online || busy || !project}
                        onClick={() => void savePolicy(server.name)}
                      >
                        Save policy
                      </Button>
                      <Button
                        variant="app"
                        className="settings-button"
                        disabled={!online || busy || !server.policy}
                        onClick={() =>
                          void run(() =>
                            hostRequest(hostKey, 'mcp.policy.set', {
                              cwd: project?.path,
                              name: server.name,
                              policy: null,
                            }),
                          )
                        }
                      >
                        Clear
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>

          {removing && (
            <div className="settings-notice" role="alert">
              <p>
                Remove {removing.name} from {current?.label}? Its other settings stay as they are.
              </p>
              <div className="settings-actions">
                <Button
                  variant="app"
                  className="settings-button"
                  disabled={busy}
                  onClick={() => setRemoving(undefined)}
                >
                  Cancel
                </Button>
                <Button
                  variant="app"
                  className="settings-button danger"
                  disabled={busy}
                  onClick={() =>
                    void run(() =>
                      hostRequest(hostKey, 'mcp.remove', {
                        instanceId: current!.id,
                        name: removing.name,
                        scope: removing.scope,
                      }),
                    ).then(() => setRemoving(undefined))
                  }
                >
                  Remove server
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </>
  )
}
