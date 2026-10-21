import { useEffect, useRef, useState } from 'react'
import { Monitor, RefreshCw, Server, Trash2, X } from 'lucide-react'
import type { Device, PairingCode, TailnetPeer, TailnetStatus } from '@beddcode/contracts'
import {
  addRemoteHost,
  activeRoute,
  hostRequest,
  removeRemoteHost,
  useHostStore,
} from '../../stores/host.ts'
import {
  DEFAULT_PORT,
  LOCAL_HOST_KEY,
  pairWithHost,
  parseAddress,
  peerAddresses,
  wsUrl,
  type Address,
} from '../../stores/hostCatalog.ts'

const connectionText = {
  connected: 'Online',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  stopped: 'Stopped',
  denied: 'Pairing no longer valid. Pair again.',
} as const

/** Everything about hosts: the ones you have, adding another, and letting others connect here. */
export function HostsDialog({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Hosts">
        <header className="modal-head">
          <h2>Hosts</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-body">
          <HostList />
          <AddHost />
          <ShareThisComputer />
          <PairedDevices />
        </div>
      </div>
    </div>
  )
}

function HostList() {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  return (
    <section>
      <h3>Your hosts</h3>
      {entries.map((e) => {
        const r = runtimes[e.key]
        const state = r?.connection ?? 'connecting'
        const local = e.key === LOCAL_HOST_KEY
        const route = local ? 'This computer' : activeRoute(e.key)?.replace(/^ws:\/\/|\/ws$/g, '')
        return (
          <div className="host-row" key={e.key}>
            {local ? <Monitor size={16} /> : <Server size={16} />}
            <span className="host-main">
              <span className="host-name">{r?.host?.name ?? e.name}</span>
              <span className="muted">{route}</span>
            </span>
            <span className="host-state">
              <span className={`dot ${state === 'connected' ? 'ok' : 'warn'}`} />
              {connectionText[state]}
            </span>
            {!local && (
              <button
                className="icon-btn small"
                aria-label={`Remove ${e.name}`}
                title="Remove this host"
                onClick={() => {
                  if (window.confirm(`Remove ${e.name}? You can pair with it again later.`)) {
                    removeRemoteHost(e.key)
                  }
                }}
              >
                <Trash2 size={15} />
              </button>
            )}
          </div>
        )
      })}
    </section>
  )
}

function AddHost() {
  const local = useHostStore((s) => s.runtimes[LOCAL_HOST_KEY])
  const entries = useHostStore((s) => s.entries)
  const [tailnet, setTailnet] = useState<TailnetStatus | 'loading' | null>(null)
  const [addresses, setAddresses] = useState<Address[]>([])
  const [typed, setTyped] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [done, setDone] = useState<string>()
  const codeInput = useRef<HTMLInputElement>(null)

  const scan = () => {
    setTailnet('loading')
    hostRequest(LOCAL_HOST_KEY, 'tailnet.peers', {}).then(setTailnet, (err: unknown) =>
      setTailnet({
        state: 'error',
        message: err instanceof Error ? err.message : String(err),
        peers: [],
      }),
    )
  }
  // Look once when the dialog opens, if this computer's host is up to ask.
  useEffect(() => {
    if (local?.connection === 'connected') scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [local?.connection === 'connected'])

  const choose = (peer: TailnetPeer, port: number) => {
    setAddresses(peerAddresses(peer, port))
    setTyped(`${peer.dnsName || peer.ip}${port === DEFAULT_PORT ? '' : `:${port}`}`)
    setError(undefined)
    codeInput.current?.focus()
  }

  const pair = async () => {
    if (busy) return
    const list = typed.trim() && addresses.length === 0 ? [parseAddress(typed)] : addresses
    const targets = list.filter((a): a is Address => a !== null)
    if (targets.length === 0)
      return setError('Enter the host address, like build-server or 100.64.1.2')
    if (!/^\d{6}$/.test(code.trim())) return setError('The pairing code has 6 digits')
    setBusy(true)
    setError(undefined)
    setDone(undefined)
    let lastError = 'Could not pair'
    for (const address of targets) {
      try {
        const result = await pairWithHost(address, code, local?.host?.name ?? 'BeddCode')
        if (result.host.hostId === local?.host?.hostId) {
          throw new Error('That is this computer. Pair with a different machine.')
        }
        addRemoteHost({
          key: result.host.hostId,
          name: result.host.name,
          routes: targets.map(wsUrl),
          token: result.token,
        })
        setDone(`Paired with ${result.host.name}`)
        setTyped('')
        setCode('')
        setAddresses([])
        setBusy(false)
        return
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
        // A wrong code or a refusal will not improve on another route; only unreachable ones will.
        if (!/Could not reach/.test(lastError)) break
      }
    }
    setError(lastError)
    setBusy(false)
  }

  const known = new Set(entries.map((e) => e.key))
  const peers = tailnet && tailnet !== 'loading' ? tailnet.peers : []

  return (
    <section>
      <h3>
        Add a host
        <button
          className="icon-btn small"
          aria-label="Look again"
          title="Look for hosts on your tailnet"
          onClick={scan}
          disabled={tailnet === 'loading' || local?.connection !== 'connected'}
        >
          <RefreshCw size={14} />
        </button>
      </h3>
      <p className="muted small">
        On the other computer, run <code>beddcode-server install-service</code>, then{' '}
        <code>beddcode-server pair</code> for a code.
      </p>

      {tailnet === 'loading' && <div className="muted small">Looking at your tailnet…</div>}
      {tailnet && tailnet !== 'loading' && tailnet.state !== 'running' && (
        <div className="muted small">
          {tailnet.message ?? 'Tailscale is not available'}. You can still type an address below.
        </div>
      )}
      {peers.length > 0 && (
        <div className="peer-list">
          {peers.map((p) => {
            const host = p.beddcode
            const added = host ? known.has(host.hostId) : false
            return (
              <button
                key={p.ip}
                className="peer-row"
                disabled={!p.online || !host || added}
                onClick={() => host && choose(p, host.port)}
              >
                <span className={`dot ${host ? 'ok' : ''}`} />
                <span className="host-main">
                  <span className="host-name">{p.name}</span>
                  <span className="muted">
                    {p.os} · {p.ip}
                  </span>
                </span>
                <span className="muted small">
                  {added
                    ? 'Added'
                    : host
                      ? 'BeddCode found'
                      : p.online
                        ? 'No BeddCode host'
                        : 'Offline'}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div className="pair-form">
        <input
          className="path-input"
          placeholder="Address, e.g. build-server or 100.64.1.2:3773"
          value={typed}
          onChange={(e) => {
            setTyped(e.target.value)
            setAddresses([])
          }}
          aria-label="Host address"
          disabled={busy}
        />
        <input
          ref={codeInput}
          className="path-input code"
          placeholder="6-digit code"
          inputMode="numeric"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          onKeyDown={(e) => e.key === 'Enter' && void pair()}
          aria-label="Pairing code"
          disabled={busy}
        />
        <button className="primary-btn" disabled={busy} onClick={() => void pair()}>
          {busy ? 'Pairing…' : 'Pair'}
        </button>
      </div>
      {error && <div className="composer-error">{error}</div>}
      {done && <div className="muted small">{done}</div>}
    </section>
  )
}

/** Devices allowed to use this host. Removing a host from the client alone does not revoke access. */
function PairedDevices() {
  const local = useHostStore((s) => s.runtimes[LOCAL_HOST_KEY])
  const connected = local?.connection === 'connected'
  const epoch = local?.epoch
  const [devices, setDevices] = useState<Device[] | null>(null)
  const [error, setError] = useState<string>()
  const [revoking, setRevoking] = useState<string>()

  const refresh = () => {
    setError(undefined)
    hostRequest(LOCAL_HOST_KEY, 'devices.list', {}).then(setDevices, (err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
  }

  useEffect(() => {
    if (!connected) return
    let cancelled = false
    hostRequest(LOCAL_HOST_KEY, 'devices.list', {}).then(
      (list) => {
        if (!cancelled) {
          setDevices(list)
          setError(undefined)
        }
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      },
    )
    return () => {
      cancelled = true
    }
  }, [connected, epoch])

  const revoke = async (device: Device) => {
    if (
      revoking ||
      !window.confirm(
        `Revoke ${device.name}? Its active connections will close and it will need a new pairing code.`,
      )
    )
      return
    setRevoking(device.id)
    setError(undefined)
    try {
      await hostRequest(LOCAL_HOST_KEY, 'devices.revoke', { id: device.id })
      setDevices((list) => list?.filter((d) => d.id !== device.id) ?? null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRevoking(undefined)
    }
  }

  return (
    <section>
      <h3>
        Paired devices
        <button
          className="icon-btn small"
          aria-label="Refresh paired devices"
          onClick={refresh}
          disabled={!connected}
        >
          <RefreshCw size={14} />
        </button>
      </h3>
      <p className="muted small">
        Devices allowed to connect to this computer. Revoking a device closes its connections
        immediately.
      </p>
      {!connected ? (
        <p className="muted small">Connect to this computer's host to manage devices.</p>
      ) : devices === null ? (
        <p className="muted small">Loading paired devices…</p>
      ) : devices.length === 0 ? (
        <p className="muted small">No paired devices.</p>
      ) : (
        devices.map((device) => (
          <div className="host-row" key={device.id}>
            <Monitor size={16} />
            <span className="host-main">
              <span className="host-name">{device.name}</span>
              <span className="muted">
                {device.lastUsedAt
                  ? `Last connected ${new Date(device.lastUsedAt).toLocaleString()}`
                  : `Paired ${new Date(device.createdAt).toLocaleString()}`}
              </span>
            </span>
            <button
              className="icon-btn small"
              aria-label={`Revoke ${device.name}`}
              title="Revoke access"
              disabled={Boolean(revoking)}
              onClick={() => void revoke(device)}
            >
              <Trash2 size={15} />
            </button>
          </div>
        ))
      )}
      {error && (
        <div className="composer-error" role="alert">
          {error}
        </div>
      )}
    </section>
  )
}

/** Shows a code that lets another computer pair with the host running on this one. */
function ShareThisComputer() {
  const [code, setCode] = useState<PairingCode>()
  const [error, setError] = useState<string>()
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    if (!code) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code])

  const left = code ? Math.max(0, Math.round((code.expiresAt - now) / 1000)) : 0
  return (
    <section>
      <h3>Let another computer connect to this one</h3>
      <p className="muted small">
        This computer&apos;s host must listen beyond this machine: start it with{' '}
        <code>--host 0.0.0.0</code> (or <code>install-service</code>). Only your tailnet and paired
        devices can connect.
      </p>
      {code && left > 0 ? (
        <div className="pair-code">
          <strong>{code.code}</strong>
          <span className="muted small">
            works once, {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} left
          </span>
        </div>
      ) : null}
      <button
        className="primary-btn"
        onClick={() =>
          hostRequest(LOCAL_HOST_KEY, 'host.pair', {}).then(
            (c) => (setCode(c), setNow(Date.now()), setError(undefined)),
            (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
          )
        }
      >
        {code ? 'New code' : 'Show a pairing code'}
      </button>
      {error && <div className="composer-error">{error}</div>}
    </section>
  )
}
