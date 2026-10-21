import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Monitor, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react'
import type { Device, PairingCode, TailnetStatus } from '@beddcode/contracts'
import { hostRequest, useHostStore } from '../../stores/host.ts'
import { DEFAULT_PORT, LOCAL_HOST_KEY, parseAddress } from '../../stores/hostCatalog.ts'
import {
  CopyHostText,
  HostCommand,
  HostNote,
  HostSpinner,
  INSTALL_HOST_COMMAND,
  useHostMounted,
} from './HostControls.tsx'

export function ShareThisComputer({ onClose }: { onClose(): void }) {
  const local = useHostStore((s) => s.runtimes[LOCAL_HOST_KEY])
  const localEntry = useHostStore((s) => s.entries.find((entry) => entry.key === LOCAL_HOST_KEY))
  const [code, setCode] = useState<PairingCode>()
  const [tailnet, setTailnet] = useState<TailnetStatus>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [now, setNow] = useState(Date.now())
  const pending = useRef(false)
  const alive = useHostMounted()
  const connected = local?.connection === 'connected'
  const generate = useCallback(async () => {
    if (pending.current || !connected) return
    pending.current = true
    setBusy(true)
    setError(undefined)
    try {
      const result = await hostRequest(LOCAL_HOST_KEY, 'host.pair', {})
      if (alive.current) {
        setCode(result)
        setNow(Date.now())
      }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      pending.current = false
      if (alive.current) setBusy(false)
    }
  }, [alive, connected])
  useEffect(() => {
    if (!connected) return
    void generate()
    let cancelled = false
    void (async () => {
      try {
        const result = await hostRequest(LOCAL_HOST_KEY, 'tailnet.peers', {})
        if (!cancelled) setTailnet(result)
      } catch {
        /* Address entry remains available without discovery. */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [connected, generate])
  useEffect(() => {
    if (!code) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code])
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0
  const host = tailnet?.self?.dnsName || tailnet?.self?.ip || local?.host?.name
  const port = parseAddress(localEntry?.routes[0] ?? '')?.port ?? DEFAULT_PORT
  const address = host ? `${host}:${port}` : undefined
  return (
    <>
      <div className="hosts-dialog-body">
        <div className="hosts-flow-heading">
          <h2>Connect to this computer</h2>
          <p>On your other computer, open Hosts → Add host and enter this address and code.</p>
        </div>
        <div className="hosts-help boxed">
          <h3>This computer&apos;s address</h3>
          <div className="hosts-address-copy">
            <code>{address ?? 'Use this computer’s network address'}</code>
            {address && <CopyHostText text={address} label="Copy host address" iconOnly />}
          </div>
          {!tailnet?.self && <p>Use a network address reachable from the other computer.</p>}
        </div>
        {!connected ? (
          <HostNote tone="warning">
            Connect to this computer&apos;s host to create a pairing code.
          </HostNote>
        ) : busy && !code ? (
          <HostNote icon={<HostSpinner />}>Creating a pairing code…</HostNote>
        ) : code && left > 0 ? (
          <div className="hosts-field">
            <div className="hosts-section-title">
              <h3>One-time pairing code</h3>
              <span className="hosts-timer">
                <Clock size={13} />
                {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} remaining
              </span>
            </div>
            <output aria-label="One-time pairing code">
              <span className="sr-only">{code.code}</span>
              <span className="hosts-code-cells" aria-hidden="true">
                {code.code.split('').map((digit, i) => (
                  <span key={i}>{digit}</span>
                ))}
              </span>
            </output>
            <div className="hosts-code-caption">
              <CopyHostText text={code.code} label="Copy code" />
              <p>Works once · expires in 10 minutes</p>
            </div>
          </div>
        ) : (
          !error && (
            <HostNote tone="warning" icon={<Clock size={16} />}>
              This pairing code has expired. Create a new code to continue.
            </HostNote>
          )
        )}
        {error && <HostNote tone="error">{error}</HostNote>}
        <HostNote icon={<ShieldCheck size={16} />}>
          Use this code to pair another device with this host.
        </HostNote>
        <div className="hosts-help separated">
          <h3>The host must accept remote connections.</h3>
          <HostCommand label="Run the host in the background" command={INSTALL_HOST_COMMAND} />
          <p>Use Devices with access to revoke a paired device later.</p>
        </div>
      </div>
      <footer className="hosts-dialog-footer">
        <button
          className="hosts-button"
          disabled={!connected || busy}
          onClick={() => void generate()}
        >
          {busy && <HostSpinner />}
          {code && left > 0 ? 'New code' : 'Create new code'}
        </button>
        <button className="hosts-button primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </>
  )
}

export function PairedDevices({ onClose }: { onClose(): void }) {
  const local = useHostStore((s) => s.runtimes[LOCAL_HOST_KEY])
  const [devices, setDevices] = useState<Device[]>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [revoking, setRevoking] = useState<string>()
  const alive = useHostMounted()
  const refreshId = useRef(0)
  const revokeBusy = useRef(false)
  const connected = local?.connection === 'connected'
  const refresh = useCallback(async () => {
    if (!connected) return
    const id = ++refreshId.current
    setBusy(true)
    setError(undefined)
    try {
      const list = await hostRequest(LOCAL_HOST_KEY, 'devices.list', {})
      if (alive.current && refreshId.current === id) setDevices(list)
    } catch (err) {
      if (alive.current && refreshId.current === id)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current && refreshId.current === id) setBusy(false)
    }
  }, [alive, connected])
  useEffect(() => {
    void refresh()
    return () => {
      refreshId.current++
    }
  }, [refresh, local?.epoch])
  const revoke = async (device: Device) => {
    if (
      revokeBusy.current ||
      !window.confirm(
        `Revoke ${device.name}? Its active connections will close and it will need a new pairing code.`,
      )
    )
      return
    revokeBusy.current = true
    setRevoking(device.id)
    setError(undefined)
    try {
      await hostRequest(LOCAL_HOST_KEY, 'devices.revoke', { id: device.id })
      if (alive.current) {
        refreshId.current++
        setBusy(false)
        setDevices((list) => list?.filter((d) => d.id !== device.id))
      }
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      revokeBusy.current = false
      if (alive.current) setRevoking(undefined)
    }
  }
  return (
    <>
      <div className="hosts-dialog-body">
        <div className="hosts-flow-heading">
          <h2>Devices with access</h2>
          <p>
            Devices allowed to connect to this PC. Revoking access closes their active connections
            immediately.
          </p>
        </div>
        <div className="hosts-section-title">
          <h3>Paired devices</h3>
          <button
            className="hosts-link"
            disabled={!connected || busy || !!revoking}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
            Refresh
          </button>
        </div>
        {!connected ? (
          <HostNote tone="warning">
            Connect to this computer&apos;s host to manage devices.
          </HostNote>
        ) : busy && !devices ? (
          <HostNote icon={<HostSpinner />}>Loading paired devices…</HostNote>
        ) : devices?.length ? (
          <div className="hosts-list">
            {devices.map((device) => (
              <div className="hosts-saved-row" key={device.id}>
                <Monitor size={22} />
                <span className="hosts-machine">
                  <strong>{device.name}</strong>
                  <span>
                    {device.lastUsedAt
                      ? `Last connected ${new Date(device.lastUsedAt).toLocaleString()}`
                      : `Paired ${new Date(device.createdAt).toLocaleString()}`}
                  </span>
                </span>
                <button
                  className="hosts-button destructive"
                  disabled={!!revoking || busy}
                  onClick={() => void revoke(device)}
                  aria-label={`Revoke ${device.name}`}
                >
                  {revoking === device.id ? <HostSpinner /> : <Trash2 size={14} />}Revoke
                </button>
              </div>
            ))}
          </div>
        ) : (
          !busy &&
          !error && (
            <div className="hosts-empty">
              <ShieldCheck size={24} />
              <strong>No paired devices</strong>
              <p>When another computer pairs with this host, it appears here.</p>
            </div>
          )
        )}
        {error && <HostNote tone="error">{error}</HostNote>}
      </div>
      <footer className="hosts-dialog-footer">
        <span className="hosts-escape">Esc to close</span>
        <button className="hosts-button primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </>
  )
}
