import { useCallback, useEffect, useState } from 'react'
import type { RpcResult } from '@beddcode/contracts'
import { Button } from '@/components/ui/button'
import { hostRequest } from '../../stores/host.ts'

export function AllMcpServers({ hostKey, online }: { hostKey: string; online: boolean }) {
  const [overview, setOverview] = useState<RpcResult<'mcp.overview'>>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    setLoadError('')
    try {
      setOverview(await hostRequest(hostKey, 'mcp.overview', {}))
    } catch {
      setLoadError('Could not load MCP servers.')
    } finally {
      setLoading(false)
    }
  }, [hostKey])
  useEffect(() => {
    if (online) void load()
  }, [online, load])
  const copy = async (instanceId: string, name: string) => {
    setBusy(true)
    setMessage('')
    try {
      const results = await hostRequest(hostKey, 'mcp.copy', { instanceId, name })
      setMessage(
        results.length
          ? results.map((r) => `${r.label}: ${r.status}`).join(' · ')
          : 'No other agents available',
      )
      await load()
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not copy server')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="settings-section-head">
        <h3>All agents</h3>
        <Button
          variant="app"
          className="settings-button"
          disabled={!online || busy || loading}
          onClick={() => void load()}
        >
          Refresh
        </Button>
      </div>
      {message && (
        <p className="settings-notice" role="status">
          {message}
        </p>
      )}
      {loadError && (
        <p className="settings-error" role="alert">
          {loadError}
        </p>
      )}
      {overview?.errors.map((error) => (
        <p className="settings-error" key={error.instanceId}>
          {error.label}: {error.error}
        </p>
      ))}
      <div className="settings-card">
        {!overview && !online && (
          <p className="settings-empty">Connect to this host to view MCP servers.</p>
        )}
        {!overview && online && !loadError && <p className="settings-empty">Checking servers…</p>}
        {overview?.servers.length === 0 && <p className="settings-empty">No MCP servers yet.</p>}
        {overview?.servers.map((row) => (
          <div className="setting-row" key={row.name}>
            <div className="setting-label">
              <span>
                {row.name} {row.mismatch && <span className="settings-badge">Mismatch</span>}
              </span>
              {row.agents.map(({ instanceId, label, server }) => (
                <small key={instanceId}>
                  {label}: {server.transport} · {server.target} · {server.status}
                </small>
              ))}
            </div>
            <Button
              variant="app"
              className="settings-button"
              disabled={!online || busy}
              onClick={() => void copy(row.agents[0]!.instanceId, row.name)}
            >
              Copy to other agents
            </Button>
          </div>
        ))}
      </div>
    </>
  )
}
