import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, CheckCircle2, ChevronRight, RefreshCw, Server } from 'lucide-react'
import type { TailnetStatus, TailnetPeer } from '@beddcode/contracts'
import { addRemoteHost, hostRequest, useHostStore } from '../../stores/host.ts'
import {
  DEFAULT_PORT,
  LOCAL_HOST_KEY,
  pairWithHost,
  parseAddress,
  peerAddresses,
  wsUrl,
  type Address,
  type HostEntry,
} from '../../stores/hostCatalog.ts'
import { HostNote, HostSpinner, HostTarget, useHostMounted } from './HostControls.tsx'

type Target = { name: string; addresses: Address[] }

export function AddHostFlow({
  onClose,
  onStart,
}: {
  onClose(): void
  onStart(hostKey: string): void
}) {
  const local = useHostStore((s) => s.runtimes[LOCAL_HOST_KEY])
  const entries = useHostStore((s) => s.entries)
  const [tailnet, setTailnet] = useState<TailnetStatus | 'loading' | null>(null)
  const [picked, setPicked] = useState<Target & { ip: string }>()
  const [typed, setTyped] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [paired, setPaired] = useState<HostEntry>()
  const [attempt, setAttempt] = useState(0)
  const [timedOut, setTimedOut] = useState(false)
  const runtime = useHostStore((s) => (paired ? s.runtimes[paired.key] : undefined))
  const connected =
    !!paired && runtime?.connection === 'connected' && runtime.host?.hostId === paired.key
  const refused = runtime?.connection === 'denied'
  const alive = useHostMounted()
  const inFlight = useRef(false)
  const scanId = useRef(0)
  const localConnected = local?.connection === 'connected'
  const scan = useCallback(async () => {
    const id = ++scanId.current
    if (!localConnected) {
      setTailnet(null)
      return
    }
    setTailnet('loading')
    try {
      const result = await hostRequest(LOCAL_HOST_KEY, 'tailnet.peers', {})
      if (alive.current && id === scanId.current) setTailnet(result)
    } catch {
      // Typing an address still works without discovery.
      if (alive.current && id === scanId.current) setTailnet(null)
    }
  }, [alive, localConnected])
  useEffect(() => {
    void scan()
    return () => {
      scanId.current++
    }
  }, [scan])
  useEffect(() => {
    if (!paired) return
    setTimedOut(false)
    const timer = setTimeout(() => setTimedOut(true), 12_000)
    return () => clearTimeout(timer)
  }, [paired, attempt])

  const choose = (peer: TailnetPeer) => {
    if (!peer.beddcode) return
    setPicked({
      name: peer.beddcode.name || peer.name,
      addresses: peerAddresses(peer, peer.beddcode.port),
      ip: peer.ip,
    })
    setTyped('')
    setError(undefined)
  }
  const typedAddress = typed.trim() ? parseAddress(typed) : undefined
  const target: Target | undefined =
    picked ?? (typedAddress ? { name: typedAddress.host, addresses: [typedAddress] } : undefined)
  const ready = !!target && code.length === 6

  const pair = async () => {
    if (inFlight.current || !target || !/^\d{6}$/.test(code)) return
    inFlight.current = true
    setBusy(true)
    setError(undefined)
    try {
      let lastError: unknown
      for (const address of target.addresses) {
        try {
          const result = await pairWithHost(address, code, local?.host?.name ?? 'BeddCode')
          if (!alive.current) return
          if (result.host.hostId === local?.host?.hostId)
            throw new Error('That is this computer. Pair with a different machine.')
          const entry = {
            key: result.host.hostId,
            name: result.host.name,
            routes: target.addresses.map(wsUrl),
            token: result.token,
          }
          addRemoteHost(entry)
          setPaired(entry)
          return
        } catch (err) {
          lastError = err
          if (!alive.current) return
          // Only a reachability failure benefits from trying the next route.
          if (!(err instanceof Error) || !err.message.startsWith('Could not reach')) break
        }
      }
      throw lastError ?? new Error('Could not pair with this host.')
    } catch (err) {
      if (alive.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      inFlight.current = false
      if (alive.current) setBusy(false)
    }
  }

  if (paired) {
    const address = paired.routes[0]?.replace(/^wss?:\/\/|\/ws$/g, '') ?? ''
    const failed = refused || timedOut
    return (
      <>
        <div className="hosts-dialog-body">
          <div className={`hosts-flow-heading ${connected ? 'connected' : ''}`}>
            {connected && (
              <span className="hosts-success-mark">
                <Check size={28} />
              </span>
            )}
            <h2>{connected ? `${paired.name} is connected` : `Connecting to ${paired.name}`}</h2>
            <p>
              {connected
                ? 'You can now run agents and open projects on it.'
                : refused
                  ? 'The host refused this pairing. Create a fresh code on the other computer.'
                  : timedOut
                    ? 'Paired, but the connection did not finish. Check that the host is running.'
                    : 'Paired. Waiting for the host to respond…'}
            </p>
          </div>
          <HostTarget
            name={paired.name}
            address={address}
            status={
              connected
                ? 'Online'
                : refused
                  ? 'Pair again'
                  : timedOut
                    ? 'Unreachable'
                    : 'Connecting'
            }
            tone={connected ? 'success' : failed ? 'warning' : 'pending'}
          />
        </div>
        <footer className="hosts-dialog-footer">
          <button type="button" className="hosts-button" onClick={onClose}>
            Close
          </button>
          {connected ? (
            <button
              type="button"
              className="hosts-button primary"
              onClick={() => onStart(paired.key)}
            >
              Start a session
            </button>
          ) : refused ? (
            <button
              type="button"
              className="hosts-button primary"
              onClick={() => {
                setPaired(undefined)
                setCode('')
              }}
            >
              Pair again
            </button>
          ) : timedOut ? (
            <button
              type="button"
              className="hosts-button primary"
              onClick={() => {
                setAttempt((n) => n + 1)
                addRemoteHost(paired)
              }}
            >
              Retry
            </button>
          ) : (
            <button type="button" className="hosts-button primary" disabled>
              <HostSpinner />
              Connecting…
            </button>
          )}
        </footer>
      </>
    )
  }

  const peers = tailnet && tailnet !== 'loading' ? tailnet.peers.filter((p) => p.beddcode) : []
  const known = new Set(entries.map((entry) => entry.key))
  const addressError = typed.trim() && !typedAddress
  return (
    <form
      className="hosts-flow"
      onSubmit={(event) => {
        event.preventDefault()
        if (ready) void pair()
      }}
    >
      <div className="hosts-dialog-body">
        <div className="hosts-flow-heading">
          <h2>Add a computer</h2>
          <p>Pick a host, then enter the code it shows.</p>
        </div>
        <div className="hosts-field">
          <div className="hosts-section-title">
            <label htmlFor="host-address">Host</label>
            <button
              type="button"
              className="hosts-link"
              onClick={() => void scan()}
              disabled={tailnet === 'loading' || !localConnected}
            >
              <RefreshCw size={14} />
              Refresh
            </button>
          </div>
          {tailnet === 'loading' ? (
            <HostNote icon={<HostSpinner />}>Looking for hosts on your network…</HostNote>
          ) : (
            peers.length > 0 && (
              <div className="hosts-peer-list">
                {peers.map((peer) => {
                  const host = peer.beddcode!
                  const added = known.has(host.hostId) || host.hostId === local?.host?.hostId
                  const selected = picked?.ip === peer.ip
                  return (
                    <button
                      key={peer.ip}
                      type="button"
                      className={`hosts-peer ${selected ? 'selected' : ''}`}
                      disabled={!peer.online || added}
                      aria-pressed={selected}
                      onClick={() => choose(peer)}
                    >
                      <Server size={22} />
                      <span className="hosts-machine">
                        <strong>{host.name || peer.name}</strong>
                        <code>
                          {peer.os} · {peer.ip}
                        </code>
                      </span>
                      <span className={`hosts-status ${peer.online && !added ? 'success' : ''}`}>
                        {added ? 'Already added' : peer.online ? '' : 'Offline'}
                      </span>
                      {selected ? <Check size={15} /> : <ChevronRight size={15} />}
                    </button>
                  )
                })}
              </div>
            )
          )}
          <input
            id="host-address"
            value={typed}
            placeholder={peers.length ? 'Or enter an address' : 'Machine name or IP address'}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!addressError}
            onChange={(event) => {
              setTyped(event.target.value)
              setPicked(undefined)
              setError(undefined)
            }}
          />
          <p>
            {addressError
              ? 'Enter a machine name or IP address, with an optional :port.'
              : `Default port is ${DEFAULT_PORT}.`}
          </p>
        </div>
        <div className="hosts-field">
          <label htmlFor="host-pairing-code">Pairing code</label>
          <input
            id="host-pairing-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="6 digits"
            value={code}
            disabled={busy}
            aria-invalid={!!error}
            aria-describedby={error ? 'host-pair-error' : undefined}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
              setError(undefined)
            }}
          />
          {error && (
            <div id="host-pair-error">
              <HostNote tone="error" icon={<AlertCircle size={16} />}>
                {error}
              </HostNote>
            </div>
          )}
        </div>
        {target && !error && (
          <HostNote tone="success" icon={<CheckCircle2 size={16} />}>
            Pairing with {target.name}
          </HostNote>
        )}
      </div>
      <footer className="hosts-dialog-footer">
        <button type="button" className="hosts-button" onClick={onClose}>
          Cancel
        </button>
        <button type="submit" className="hosts-button primary" disabled={busy || !ready}>
          {busy && <HostSpinner />}
          {busy ? 'Pairing…' : 'Pair and connect'}
        </button>
      </footer>
    </form>
  )
}
