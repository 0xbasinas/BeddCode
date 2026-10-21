import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronRight,
  Circle,
  Link2,
  RefreshCw,
  Search,
  Server,
  WifiOff,
  AlertCircle,
} from 'lucide-react'
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
import {
  HostCommand,
  HostNote,
  HostSpinner,
  HostTarget,
  INSTALL_HOST_COMMAND,
  PAIR_HOST_COMMAND,
  useHostMounted,
} from './HostControls.tsx'

type Step = 'choose' | 'manual' | 'setup' | 'pair'
type Target = { name: string; addresses: Address[]; discovered: boolean }

export function HostFlowFooter({
  children,
  onBack,
  onClose,
  saved = false,
}: {
  children?: ReactNode
  onBack?: () => void
  onClose(): void
  saved?: boolean
}) {
  return (
    <footer className="hosts-dialog-footer">
      {onBack ? (
        <button type="button" className="hosts-back" onClick={onBack}>
          <ArrowLeft size={14} />
          Back
        </button>
      ) : (
        <span className="hosts-escape">Esc to close</span>
      )}
      <div>
        <button type="button" className="hosts-button" onClick={onClose}>
          {saved ? 'Close' : 'Cancel'}
        </button>
        {children}
      </div>
    </footer>
  )
}

export function HostSteps({ step }: { step: number }) {
  return (
    <nav className="hosts-steps" aria-label="Add host progress">
      {['Choose a host', 'Pair', 'Connect'].map((label, i) => (
        <span key={label}>
          {i > 0 && <ChevronRight size={12} />}
          <span aria-current={step === i + 1 ? 'step' : undefined}>{label}</span>
        </span>
      ))}
    </nav>
  )
}

export function AddHostFlow({
  onClose,
  onStart,
}: {
  onClose(): void
  onStart(hostKey: string): void
}) {
  const local = useHostStore((s) => s.runtimes[LOCAL_HOST_KEY])
  const entries = useHostStore((s) => s.entries)
  const [step, setStep] = useState<Step>('choose')
  const [tailnet, setTailnet] = useState<TailnetStatus | 'loading' | null>(null)
  const [target, setTarget] = useState<Target>()
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
  const codeInput = useRef<HTMLInputElement>(null)
  const addressInput = useRef<HTMLInputElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const localConnected = local?.connection === 'connected'
  const scan = useCallback(async () => {
    const id = ++scanId.current
    if (!localConnected) {
      setTailnet({
        state: 'error',
        message:
          "Connect to this computer's host to discover your network. You can still enter an address.",
        peers: [],
      })
      return
    }
    setTailnet('loading')
    try {
      const result = await hostRequest(LOCAL_HOST_KEY, 'tailnet.peers', {})
      if (alive.current && id === scanId.current) setTailnet(result)
    } catch (err) {
      if (alive.current && id === scanId.current)
        setTailnet({
          state: 'error',
          message: err instanceof Error ? err.message : String(err),
          peers: [],
        })
    }
  }, [alive, localConnected])
  useEffect(() => {
    void scan()
    return () => {
      scanId.current++
    }
  }, [scan])
  useEffect(() => {
    if (step === 'pair' && !paired) codeInput.current?.focus()
    else if (step === 'manual') addressInput.current?.focus()
    else heading.current?.focus()
  }, [step, paired, connected])
  useEffect(() => {
    if (!paired) return
    setTimedOut(false)
    const timer = setTimeout(() => setTimedOut(true), 12_000)
    return () => clearTimeout(timer)
  }, [paired, attempt])

  const choose = (peer: TailnetPeer) => {
    if (!peer.beddcode) return
    setTarget({
      name: peer.beddcode.name || peer.name,
      addresses: peerAddresses(peer, peer.beddcode.port),
      discovered: true,
    })
    setError(undefined)
  }
  const next = () => {
    if (step === 'manual') {
      const address = parseAddress(typed)
      if (!address) {
        setError('Enter a machine name or IP address with an optional port from 1 to 65535.')
        return
      }
      setTarget({ name: address.host, addresses: [address], discovered: false })
    }
    if (step === 'choose' && !target) return
    setError(undefined)
    setStep('pair')
  }
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
  const address = target?.addresses[0]
  const targetAddress = address
    ? `${address.host}${address.port === DEFAULT_PORT ? '' : `:${address.port}`}`
    : ''
  const peers = tailnet && tailnet !== 'loading' ? tailnet.peers : []
  const known = new Set(entries.map((entry) => entry.key))
  const changeStep = (nextStep: Step) => {
    setError(undefined)
    setStep(nextStep)
  }
  const title = connected
    ? `${paired!.name} is connected`
    : paired
      ? refused
        ? `Pair with ${paired.name} again`
        : timedOut
          ? `Couldn't reach ${paired.name}`
          : `Connecting to ${paired.name}`
      : step === 'choose'
        ? 'Add another computer'
        : step === 'manual'
          ? 'Connect by address'
          : step === 'setup'
            ? 'Set up the other computer'
            : `Pair with ${target?.name}`
  const description = connected
    ? 'You can now run agents and open projects on this host.'
    : paired
      ? refused
        ? 'The host refused this pairing. Create a fresh code on the other computer.'
        : timedOut
          ? 'Your pairing was saved, but the host connection did not finish.'
          : 'The code was accepted. Waiting for the host to respond.'
      : step === 'choose'
        ? 'Choose a BeddCode host on your Tailscale network.'
        : step === 'manual'
          ? 'Use a machine name, Tailscale IP, or a reachable host URL.'
          : step === 'setup'
            ? 'Open your BeddCode checkout after installing dependencies.'
            : 'Enter the code shown on the other computer.'

  return (
    <form
      className="hosts-flow"
      onSubmit={(event) => {
        event.preventDefault()
        if (paired) return
        if (step === 'pair') void pair()
        else if (step === 'choose' || step === 'manual') next()
      }}
    >
      <div className="hosts-dialog-body">
        {!connected && <HostSteps step={paired ? 3 : step === 'pair' ? 2 : 1} />}
        <div className={`hosts-flow-heading ${connected ? 'connected' : ''}`}>
          {connected && (
            <span className="hosts-success-mark">
              <Check size={28} />
            </span>
          )}
          <h2 ref={heading} tabIndex={-1}>
            {title}
          </h2>
          <p>{description}</p>
        </div>
        {paired ? (
          <>
            <HostTarget
              name={paired.name}
              address={targetAddress}
              status={
                connected
                  ? 'Online'
                  : refused
                    ? 'Pair again'
                    : timedOut
                      ? 'Unreachable'
                      : 'Connecting'
              }
              tone={connected ? 'success' : refused || timedOut ? 'warning' : 'pending'}
            />
            {connected ? (
              <>
                <div className="hosts-connection-checks" role="status">
                  <HostNote tone="success" icon={<CheckCircle2 size={16} />}>
                    Connection verified
                  </HostNote>
                  <HostNote tone="success" icon={<CheckCircle2 size={16} />}>
                    Saved for automatic reconnection
                  </HostNote>
                </div>
                <p className="hosts-divider-note">
                  Choose {paired.name} in the new-session composer to begin.
                </p>
              </>
            ) : (
              <>
                <div className="hosts-connection-checks boxed" role="status">
                  <HostNote tone="success" icon={<CheckCircle2 size={16} />}>
                    Pairing code accepted
                  </HostNote>
                  <HostNote
                    tone={refused || timedOut ? 'warning' : ''}
                    icon={refused || timedOut ? <AlertCircle size={16} /> : <HostSpinner />}
                  >
                    {refused
                      ? 'Pairing is no longer valid'
                      : timedOut
                        ? 'Connection timed out'
                        : 'Opening the host connection…'}
                  </HostNote>
                  {!timedOut && !refused && (
                    <HostNote icon={<Circle size={16} />}>Checking the host identity</HostNote>
                  )}
                </div>
                {timedOut || refused ? (
                  <div className="hosts-help">
                    <h3>Check the other computer</h3>
                    <p>
                      Keep the host running and make sure both computers can reach each other on the
                      same network.
                    </p>
                    <details>
                      <summary>Connection details</summary>
                      <code>{paired.routes[0]?.replace(/^ws:\/\/|\/ws$/g, '')}</code>
                    </details>
                  </div>
                ) : (
                  <p className="hosts-secondary-copy">
                    This usually takes a few seconds. Your host will appear in the list once the
                    connection is verified.
                  </p>
                )}
                {!refused && (
                  <HostNote>
                    You can close this dialog. BeddCode will keep trying to reconnect.
                  </HostNote>
                )}
              </>
            )}
          </>
        ) : step === 'choose' ? (
          <>
            <div className="hosts-discovery">
              <div className="hosts-section-title">
                <h3>Available on your network</h3>
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
                <div className="hosts-empty" role="status">
                  <HostSpinner />
                  <strong>Looking for BeddCode hosts…</strong>
                  <p>Checking computers on your Tailscale network.</p>
                  <div className="hosts-skeleton" />
                  <div className="hosts-skeleton" />
                </div>
              ) : tailnet && tailnet.state !== 'running' ? (
                <div className="hosts-empty">
                  <HostNote tone="warning" icon={<WifiOff size={18} />}>
                    {localConnected
                      ? 'Tailscale discovery is unavailable'
                      : 'This computer’s host is unavailable'}
                  </HostNote>
                  <p>{tailnet.message ?? 'Connect Tailscale on both computers, then try again.'}</p>
                  <p>You can still enter an address below.</p>
                </div>
              ) : peers.length === 0 ? (
                <div className="hosts-empty">
                  <strong>No BeddCode hosts found</strong>
                  <p>Start BeddCode on the other computer, or enter its address.</p>
                </div>
              ) : (
                <div className="hosts-peer-list">
                  {peers.map((peer) => {
                    const host = peer.beddcode
                    const added =
                      !!host && (known.has(host.hostId) || host.hostId === local?.host?.hostId)
                    const selected =
                      !!host &&
                      target?.discovered &&
                      target.addresses[0]?.host === (peer.dnsName || peer.ip)
                    const unavailable = !peer.online || !host || added
                    return (
                      <button
                        key={peer.ip}
                        type="button"
                        className={`hosts-peer ${selected ? 'selected' : ''}`}
                        disabled={unavailable}
                        aria-pressed={!!selected}
                        onClick={() => choose(peer)}
                      >
                        <Server size={22} />
                        <span className="hosts-machine">
                          <strong>{host?.name || peer.name}</strong>
                          <code>
                            {peer.os} · {peer.ip}
                          </code>
                        </span>
                        <span className={`hosts-status ${!unavailable ? 'success' : ''}`}>
                          {added
                            ? 'Already added'
                            : !peer.online
                              ? 'Offline'
                              : !host
                                ? 'Setup needed'
                                : selected
                                  ? 'Selected'
                                  : 'Ready to pair'}
                        </span>
                        {selected || added ? <Check size={15} /> : <ChevronRight size={15} />}
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
            <button
              type="button"
              className="hosts-route-button"
              onClick={() => changeStep('manual')}
            >
              <Link2 size={16} />
              Enter an address instead
              <ArrowRight size={16} />
            </button>
            <div className="hosts-help separated">
              <h3>Host not listed?</h3>
              <p>Make sure BeddCode is running on the other machine.</p>
              <button
                type="button"
                className="hosts-link accent"
                onClick={() => changeStep('setup')}
              >
                Set up a host ↗
              </button>
            </div>
          </>
        ) : step === 'manual' ? (
          <>
            <div className="hosts-field">
              <label htmlFor="host-address">Host address</label>
              <input
                id="host-address"
                ref={addressInput}
                value={typed}
                placeholder="e.g. build-server or 100.64.0.12"
                autoComplete="off"
                spellCheck={false}
                aria-invalid={!!error}
                aria-describedby={error ? 'host-address-error' : 'host-address-help'}
                onChange={(event) => {
                  setTyped(event.target.value)
                  setError(undefined)
                }}
              />
              <p id="host-address-help">Default port is 3773. Add :port for a custom port.</p>
              {error && (
                <div id="host-address-error">
                  <HostNote tone="error">{error}</HostNote>
                </div>
              )}
            </div>
            <div className="hosts-help boxed">
              <h3>Works with</h3>
              <code>build-server · 100.64.0.12:3773</code>
              <code>http://build-server:3773</code>
            </div>
            <HostNote>The host must be running and reachable from this computer.</HostNote>
            <button
              type="button"
              className="hosts-route-button"
              onClick={() => changeStep('choose')}
            >
              <Search size={16} />
              Find hosts on my network
            </button>
          </>
        ) : step === 'setup' ? (
          <div className="hosts-help">
            <HostNote>
              Connect both computers to the same Tailscale network, then run these commands on the
              other computer.
            </HostNote>
            <HostCommand label="1. Run the host in the background" command={INSTALL_HOST_COMMAND} />
            <HostCommand label="2. Create a pairing code" command={PAIR_HOST_COMMAND} />
            <p>Keep the checkout and its dependencies in place while the host is running.</p>
            <button
              type="button"
              className="hosts-route-button"
              onClick={() => {
                changeStep('choose')
                void scan()
              }}
            >
              <RefreshCw size={16} />
              Look for the host again
            </button>
            <button type="button" className="hosts-link" onClick={() => changeStep('manual')}>
              Enter its address instead
              <ArrowRight size={14} />
            </button>
          </div>
        ) : (
          <>
            <HostTarget
              name={target?.name ?? ''}
              address={targetAddress}
              status={target?.discovered ? 'Available' : 'Address entered'}
              tone={target?.discovered ? 'success' : ''}
            />
            <div className="hosts-field">
              <label htmlFor="host-pairing-code">Pairing code</label>
              <div className={`hosts-code-input ${error ? 'invalid' : ''}`}>
                <div className="hosts-code-cells" aria-hidden="true">
                  {Array.from({ length: 6 }, (_, index) => (
                    <span
                      key={index}
                      className={index === Math.min(code.length, 5) ? 'current' : ''}
                    >
                      {code[index] ?? ''}
                    </span>
                  ))}
                </div>
                <input
                  ref={codeInput}
                  id="host-pairing-code"
                  aria-label="Pairing code"
                  aria-describedby={error ? 'host-pair-error' : 'host-code-help'}
                  aria-invalid={!!error}
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  disabled={busy}
                  onChange={(event) => {
                    setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
                    setError(undefined)
                  }}
                />
              </div>
              <p id="host-code-help">
                Six digits. You can paste the entire code, including spaces.
              </p>
              {error && (
                <div id="host-pair-error">
                  <HostNote tone="error" icon={<AlertCircle size={16} />}>
                    {error}
                  </HostNote>
                </div>
              )}
            </div>
            <div className="hosts-help">
              <h3>
                {error && !error.startsWith('Could not reach')
                  ? 'Get a fresh code'
                  : 'Need a pairing code?'}
              </h3>
              <p>On {target?.name}, open your BeddCode checkout and run:</p>
              <HostCommand label="Create a one-time code" command={PAIR_HOST_COMMAND} />
              <p>The code works once and expires after 10 minutes.</p>
            </div>
          </>
        )}
      </div>
      <HostFlowFooter
        onBack={
          !paired && step !== 'choose' && !busy
            ? () => changeStep(step === 'pair' && !target?.discovered ? 'manual' : 'choose')
            : undefined
        }
        onClose={onClose}
        saved={!!paired}
      >
        {connected ? (
          <button
            type="button"
            className="hosts-button primary"
            onClick={() => onStart(paired!.key)}
          >
            Start a session
          </button>
        ) : paired ? (
          refused ? (
            <button
              type="button"
              className="hosts-button primary"
              onClick={() => {
                setPaired(undefined)
                setCode('')
                setError(undefined)
                changeStep('pair')
              }}
            >
              Pair again
            </button>
          ) : timedOut ? (
            <button
              type="button"
              className="hosts-button primary"
              onClick={() => {
                setTimedOut(false)
                setAttempt((n) => n + 1)
                addRemoteHost(paired)
              }}
            >
              Retry connection
            </button>
          ) : (
            <button type="button" className="hosts-button primary" disabled>
              <HostSpinner />
              Connecting…
            </button>
          )
        ) : (
          step !== 'setup' && (
            <button
              type="submit"
              className="hosts-button primary"
              disabled={
                busy ||
                (step === 'choose' && !target) ||
                (step === 'manual' && !typed.trim()) ||
                (step === 'pair' && code.length !== 6)
              }
            >
              {busy && <HostSpinner />}
              {step === 'pair'
                ? busy
                  ? 'Pairing…'
                  : error
                    ? 'Try again'
                    : 'Pair and connect'
                : 'Continue'}
            </button>
          )
        )}
      </HostFlowFooter>
    </form>
  )
}
