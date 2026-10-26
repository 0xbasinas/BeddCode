import { useCallback, useEffect, useRef, useState } from 'react'
import { Clock, Eye, Monitor, RefreshCw, Trash2 } from 'lucide-react'
import type { Device, PairingCode, RelaySettings } from '@beddcode/contracts'
import { hostRequest, useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY, parsePairLink } from '../../stores/hostCatalog.ts'
import { CopyHostText, HostNote, HostSpinner, useHostMounted } from './HostControls.tsx'
import { QrCode } from './QrCode.tsx'

export function ShareThisComputer({ onClose }: { onClose(): void }) {
  const local = useHostStore((s) => s.runtimes[LOCAL_HOST_KEY])
  const [code, setCode] = useState<PairingCode>()
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
  }, [connected, generate])
  useEffect(() => {
    if (!code) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [code])
  const left = code ? Math.max(0, Math.ceil((code.expiresAt - now) / 1000)) : 0
  // Only an address another device can really use is worth showing: the computer's own name
  // means nothing to a phone, so it comes from the pairing link's direct routes.
  const pairLink = code?.link ? parsePairLink(code.link) : null
  const address = pairLink?.routes[0]?.replace(/^wss?:\/\//i, '').replace(/\/ws$/, '')
  const relayOnly = !!pairLink && !pairLink.routes.length && !!pairLink.relay
  return (
    <>
      <div className="hosts-dialog-body">
        <div className="hosts-flow-heading">
          <h2>Let another computer connect</h2>
          <p>
            On your phone or another computer, scan the code below, or choose Add host and paste the
            link or enter the code.
          </p>
        </div>
        {address && (
          <div className="hosts-address-copy">
            <code>{address}</code>
            <CopyHostText text={address} label="Copy host address" iconOnly />
          </div>
        )}
        {connected && pairLink && !address && !relayOnly && (
          <HostNote tone="warning">
            Other devices cannot reach this computer yet. Turn on Connect from anywhere below, or
            allow network access for this host.
          </HostNote>
        )}
        {!connected ? (
          <HostNote tone="warning">
            Connect to this computer&apos;s host to create a pairing code.
          </HostNote>
        ) : busy && !code ? (
          <HostNote icon={<HostSpinner />}>Creating a pairing code…</HostNote>
        ) : code && left > 0 ? (
          <div className="hosts-field">
            {code.link ? (
              <div className="hosts-qr">
                <QrCode text={code.link} label="Pairing QR code" size={240} />
                <div>
                  <strong>Scan to pair</strong>
                  <p>
                    Open your phone&apos;s camera, or BeddCode on another computer, and point it
                    here. It tries every address this computer has.
                  </p>
                  <CopyHostText text={code.link} label="Copy link" />
                </div>
              </div>
            ) : null}
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
              <span className="hosts-timer">
                <Clock size={13} />
                {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')} · works once
              </span>
            </div>
          </div>
        ) : (
          !error && (
            <HostNote tone="warning" icon={<Clock size={16} />}>
              This code has expired. Create a new one.
            </HostNote>
          )
        )}
        {error && <HostNote tone="error">{error}</HostNote>}
        <RelaySetting onChange={() => void generate()} />
        <PairedDevices />
      </div>
      <footer className="hosts-dialog-footer">
        <button
          className="hosts-button"
          disabled={!connected || busy}
          onClick={() => void generate()}
        >
          {busy && <HostSpinner />}
          New code
        </button>
        <button className="hosts-button primary" onClick={onClose}>
          Done
        </button>
      </footer>
    </>
  )
}

const RELAY_STATUS: Record<RelaySettings['status'], string> = {
  off: 'Off',
  connecting: 'Connecting…',
  online: 'Connected',
  offline: 'Cannot reach the relay, retrying',
}

/** Lets devices on other networks reach this computer through a relay, set with an ordinary address. */
function RelaySetting({ onChange }: { onChange(): void }) {
  const local = useHostStore((s) => s.runtimes[LOCAL_HOST_KEY])
  const connected = local?.connection === 'connected'
  const [settings, setSettings] = useState<RelaySettings>()
  const [value, setValue] = useState('')
  const [password, setPassword] = useState('')
  const [peeking, setPeeking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const alive = useHostMounted()
  const load = useCallback(async () => {
    try {
      const next = await hostRequest(LOCAL_HOST_KEY, 'host.relay.get', {})
      if (alive.current) setSettings(next)
    } catch {
      /* An older host has no relay support; the section stays hidden. */
    }
  }, [alive])
  useEffect(() => {
    if (!connected) return
    void load()
    // The connection comes up a moment after it is set.
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  }, [connected, load, local?.epoch])
  useEffect(() => {
    if (settings) setValue((current) => current || (settings.url ?? '').replace(/^wss?:\/\//, ''))
  }, [settings])
  const save = async (url: string | null, newPassword?: string) => {
    setBusy(true)
    setError(undefined)
    try {
      const next = await hostRequest(LOCAL_HOST_KEY, 'host.relay.set', {
        url,
        ...(newPassword !== undefined ? { password: newPassword } : {}),
      })
      if (!alive.current) return
      setSettings(next)
      setPassword('')
      if (!url) setValue('')
      onChange()
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (alive.current) setBusy(false)
    }
  }
  if (!connected || !settings) return null
  return (
    <div className="hosts-field">
      <div className="hosts-section-title">
        <h3>Connect from anywhere</h3>
        <span className="hosts-secondary-copy">{RELAY_STATUS[settings.status]}</span>
      </div>
      <p className="hosts-secondary-copy">
        Paste the address of a relay (like relay.example.com) so your phone can reach this computer
        on any network. Everything stays encrypted between your devices. If you locked your relay
        with a password, enter it too.
      </p>
      <form
        className="hosts-address-copy"
        style={{ flexWrap: 'wrap' }}
        onSubmit={(e) => {
          e.preventDefault()
          if (value.trim()) void save(value.trim(), password ? password : undefined)
        }}
      >
        <input
          className="hosts-input"
          value={value}
          placeholder="relay.example.com"
          onChange={(e) => setValue(e.target.value)}
          disabled={busy}
          spellCheck={false}
          aria-label="Relay address"
        />
        <button className="hosts-button" type="submit" disabled={busy || !value.trim()}>
          {busy && <HostSpinner />}
          Save
        </button>
        <span className="hosts-peek">
          <input
            className="hosts-input"
            type={peeking ? 'text' : 'password'}
            value={password}
            placeholder={
              settings.passwordSet ? 'Password set (type to change)' : 'Password (optional)'
            }
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            autoComplete="off"
            aria-label="Relay password"
          />
          {password && (
            <button
              type="button"
              className="hosts-peek-button"
              aria-label="Hold to show the password"
              title="Hold to show"
              onPointerDown={() => setPeeking(true)}
              onPointerUp={() => setPeeking(false)}
              onPointerLeave={() => setPeeking(false)}
              onPointerCancel={() => setPeeking(false)}
              onBlur={() => setPeeking(false)}
              onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && setPeeking(true)}
              onKeyUp={() => setPeeking(false)}
            >
              <Eye size={15} />
            </button>
          )}
        </span>
        {settings.url && (
          <button
            className="hosts-button destructive"
            type="button"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Turn off
          </button>
        )}
      </form>
      {error && <HostNote tone="error">{error}</HostNote>}
    </div>
  )
}

function PairedDevices() {
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
  if (!connected) return null
  return (
    <div className="hosts-field">
      <div className="hosts-section-title">
        <h3>Devices with access</h3>
        <button
          type="button"
          className="hosts-link"
          disabled={busy || !!revoking}
          onClick={() => void refresh()}
        >
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      {busy && !devices ? (
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
        !busy && !error && <p className="hosts-secondary-copy">No devices are paired yet.</p>
      )}
      {error && <HostNote tone="error">{error}</HostNote>}
    </div>
  )
}
