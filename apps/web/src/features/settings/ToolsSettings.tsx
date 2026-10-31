import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import type { McpServer } from '@beddcode/contracts'
import { Select } from '../../ui/Select.tsx'
import { hostRequest, useRuntime } from '../../stores/host.ts'
import { emptyMcpForm, mcpInputFromForm, type McpForm } from './mcpForm.ts'
import { AddMcpDialog } from './AddMcpDialog.tsx'

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
  const { providers, connection } = useRuntime(hostKey)
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

  const load = useCallback(async () => {
    if (!current || !online) return
    setServers(null)
    setError(undefined)
    try {
      setServers(await hostRequest(hostKey, 'mcp.list', { instanceId: current.id }))
    } catch (err) {
      setServers([])
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [hostKey, current?.id, online])
  useEffect(() => void load(), [load])

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
              <Button
                variant="app"
                className="settings-button"
                disabled={!online || busy}
                onClick={() => void load()}
              >
                <RefreshCw size={13} /> Refresh
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
                  aria-label={`Remove ${server.name}`}
                  disabled={!online || busy}
                  onClick={() => setRemoving(server)}
                >
                  <Trash2 size={15} />
                </Button>
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
