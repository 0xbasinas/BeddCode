import { useCallback, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'
import type { RpcResult } from '@beddcode/contracts'
import { hostRequest, useRuntime } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'

type Settings = RpcResult<'host.mcpGateway.get'>
const labels: Record<Settings['status'], string> = {
  off: 'Disconnected',
  connecting: 'Connecting…',
  online: 'Connected',
  offline: 'Disconnected',
}

export function RemoteMcpSettings() {
  const { connection, epoch } = useRuntime(LOCAL_HOST_KEY)
  const [settings, setSettings] = useState<Settings>()
  const [url, setUrl] = useState('')
  const [secret, setSecret] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const initialized = useRef(false)
  const load = useCallback(async () => {
    try {
      setSettings(await hostRequest(LOCAL_HOST_KEY, 'host.mcpGateway.get', {}))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])
  useEffect(() => {
    if (connection !== 'connected') return
    void load()
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [connection, epoch, load])
  useEffect(() => {
    if (!settings || initialized.current) return
    initialized.current = true
    setUrl(settings.url?.replace(/^wss:/, 'https:').replace(/\/host$/, '') ?? '')
  }, [settings])
  const save = async (disconnect = false) => {
    setBusy(true)
    setError('')
    try {
      const next = await hostRequest(
        LOCAL_HOST_KEY,
        'host.mcpGateway.set',
        disconnect ? { url: null } : { url, ...(secret ? { secret } : {}) },
      )
      setSettings(next)
      setSecret('')
      if (disconnect) {
        setUrl('')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const endpoint = settings?.url
    ? settings.url.replace(/^wss:/, 'https:').replace(/\/host$/, '/mcp')
    : ''
  const updateAccess = async (change: { allowApprovals?: boolean; allowProjectRead?: boolean }) => {
    if (!settings?.url) return
    setBusy(true)
    setError('')
    try {
      setSettings(
        await hostRequest(LOCAL_HOST_KEY, 'host.mcpGateway.set', { url: settings.url, ...change }),
      )
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="settings-section-head">
        <h3>Remote MCP</h3>
      </div>
      <p className="settings-notice">
        Connect this computer to your MCP Worker so external agents can start and follow local
        sessions. The Worker can read requests and results.
      </p>
      {error && (
        <p className="settings-error" role="alert">
          {error}
        </p>
      )}
      <div className="settings-card">
        <div className="setting-row">
          <div className="setting-label">
            <span>Connection</span>
            <small>
              {connection !== 'connected'
                ? 'This computer is offline'
                : labels[settings?.status ?? 'off']}
            </small>
          </div>
        </div>
        {settings?.error && (
          <p className="settings-error" role="status">
            {settings.error}
          </p>
        )}
        <form
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <div className="setting-row">
            <label className="setting-label" htmlFor="remote-mcp-url">
              <span>Worker address</span>
              <small>Your deployed Cloudflare Worker URL</small>
            </label>
            <Input
              id="remote-mcp-url"
              className="settings-input"
              placeholder="https://your-worker.workers.dev"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="setting-row">
            <label className="setting-label" htmlFor="remote-mcp-secret">
              <span>Host secret</span>
              <small>
                {settings?.secretSet
                  ? 'Saved on this computer. Enter a new value to change it.'
                  : 'The HOST_SECRET set on your Worker'}
              </small>
            </label>
            <Input
              id="remote-mcp-secret"
              className="settings-input"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="setting-row">
            <div className="setting-label">
              <small>
                External agents can list and choose any project added to this host. A project is a
                working folder, not a sandbox. Provider permissions still apply.
              </small>
            </div>
            <Button
              variant="app"
              className="settings-button"
              disabled={
                busy ||
                connection !== 'connected' ||
                !url.trim() ||
                (!secret && !settings?.secretSet)
              }
            >
              Connect
            </Button>
            {settings?.url && (
              <Button
                variant="app"
                type="button"
                className="settings-button"
                disabled={busy}
                onClick={() => void save(true)}
              >
                Disconnect
              </Button>
            )}
          </div>
        </form>
      </div>
      {settings?.url && (
        <>
          <div className="settings-section-head">
            <h3>External agent access</h3>
          </div>
          <div className="settings-card">
            <label className="setting-row">
              <span className="setting-label">
                <span>Review project files and changes</span>
                <small>
                  Clients can read files and Git changes in any project added to this host.
                </small>
              </span>
              <Checkbox
                checked={settings.allowProjectRead}
                disabled={busy || connection !== 'connected'}
                onCheckedChange={(checked) =>
                  void updateAccess({ allowProjectRead: checked === true })
                }
              />
            </label>
            <label className="setting-row">
              <span className="setting-label">
                <span>Respond to approvals</span>
                <small>
                  Clients can allow or reject individual agent requests. This applies to every
                  client connected to the gateway.
                </small>
              </span>
              <Checkbox
                checked={settings.allowApprovals}
                disabled={busy || connection !== 'connected'}
                onCheckedChange={(checked) =>
                  void updateAccess({ allowApprovals: checked === true })
                }
              />
            </label>
            <p className="settings-notice">
              Authorized clients can view all sessions, including their full history, and answer
              agent questions.
            </p>
          </div>
        </>
      )}
      {endpoint && (
        <>
          <div className="settings-section-head">
            <h3>Connect an external agent</h3>
          </div>
          <div className="settings-card">
            <div className="setting-row">
              <div className="setting-label">
                <span>MCP URL</span>
                <small>{endpoint}</small>
              </div>
              <Button
                variant="app"
                className="settings-button"
                onClick={() => {
                  void navigator.clipboard.writeText(endpoint).then(
                    () => setCopied(true),
                    () => setError('Could not copy the URL'),
                  )
                }}
              >
                {copied ? 'Copied' : 'Copy URL'}
              </Button>
            </div>
            <p className="settings-notice">
              Connect using OAuth and sign in with your MCP_PASSWORD. Clients that support bearer
              tokens can use the password directly. Set or rotate it with Wrangler; it is separate
              from the host secret.
            </p>
          </div>
        </>
      )}
    </>
  )
}
