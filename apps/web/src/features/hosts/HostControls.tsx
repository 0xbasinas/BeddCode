import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, Info, LoaderCircle, Monitor, Server, Trash2 } from 'lucide-react'
import { activeRoute, removeRemoteHost, useHostStore } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'

export function useHostMounted() {
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  return mounted
}

export function HostNote({
  children,
  tone = '',
  icon = <Info size={16} />,
}: {
  children: ReactNode
  tone?: 'success' | 'warning' | 'error' | ''
  icon?: ReactNode
}) {
  return (
    <p className={`hosts-note ${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      {icon}
      <span>{children}</span>
    </p>
  )
}

export function HostSpinner() {
  return <LoaderCircle size={16} className="hosts-spinner" aria-hidden="true" />
}

export function CopyHostText({
  text,
  label,
  iconOnly = false,
}: {
  text: string
  label: string
  iconOnly?: boolean
}) {
  const [status, setStatus] = useState<'copied' | 'error'>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const mounted = useHostMounted()
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      if (!mounted.current) return
      setStatus('copied')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setStatus(undefined), 2000)
    } catch {
      if (mounted.current) setStatus('error')
    }
  }
  return (
    <span className="hosts-copy-wrap">
      <button
        type="button"
        className="hosts-copy"
        aria-label={status === 'copied' ? 'Copied' : label}
        title={label}
        onClick={() => void copy()}
      >
        {status === 'copied' ? <Check size={16} /> : <Copy size={16} />}
        {!iconOnly && (status === 'copied' ? 'Copied' : label)}
      </button>
      <span className={status === 'error' ? 'hosts-copy-error' : 'sr-only'} role="status">
        {status === 'error'
          ? 'Could not copy. Select and copy the text instead.'
          : status === 'copied'
            ? 'Copied to clipboard'
            : ''}
      </span>
    </span>
  )
}

export const INSTALL_HOST_COMMAND = 'pnpm --filter @beddcode/server start install-service'
export const PAIR_HOST_COMMAND = 'pnpm --filter @beddcode/server start pair'

export function HostCommand({ label, command }: { label: string; command: string }) {
  return (
    <div className="hosts-command">
      <div>
        <span>{label}</span>
        <CopyHostText text={command} label={`Copy ${label.toLowerCase()}`} iconOnly />
      </div>
      <code>{command}</code>
    </div>
  )
}

export function HostTarget({
  name,
  address,
  status = 'Available',
  tone = 'success',
}: {
  name: string
  address: string
  status?: string
  tone?: string
}) {
  return (
    <div className="hosts-target">
      <Server size={22} aria-hidden="true" />
      <span className="hosts-machine">
        <strong>{name}</strong>
        <code>{address}</code>
      </span>
      <span className={`hosts-status ${tone}`}>
        <span className="hosts-status-dot" />
        {status}
      </span>
    </div>
  )
}

const connectionText = {
  connected: 'Online',
  connecting: 'Connecting…',
  reconnecting: 'Reconnecting…',
  stopped: 'Offline',
  denied: 'Pair again',
} as const

export function HostList({ onAdd }: { onAdd(): void }) {
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  return (
    <div className="hosts-list">
      {entries.map((entry) => {
        const runtime = runtimes[entry.key]
        const state = runtime?.connection ?? 'connecting'
        const local = entry.key === LOCAL_HOST_KEY
        const platform = runtime?.host?.platform
        const os =
          platform === 'win32'
            ? 'Windows'
            : platform === 'darwin'
              ? 'macOS'
              : platform === 'linux'
                ? 'Linux'
                : undefined
        const name = local ? 'This PC' : (runtime?.host?.name ?? entry.name)
        const address = local
          ? 'This computer'
          : (activeRoute(entry.key) ?? entry.routes[0])?.replace(/^wss?:\/\/|\/ws$/g, '')
        return (
          <div className="hosts-saved-row" key={entry.key}>
            {local ? <Monitor size={22} /> : <Server size={22} />}
            <span className="hosts-machine">
              <strong>{name}</strong>
              <code>{[os, address].filter(Boolean).join(' · ')}</code>
            </span>
            {state === 'denied' ? (
              <button className="hosts-link" onClick={onAdd}>
                Pair again
              </button>
            ) : (
              <span className={`hosts-status ${state === 'connected' ? 'success' : ''}`}>
                <span className="hosts-status-dot" />
                {connectionText[state]}
              </span>
            )}
            {!local && (
              <button
                className="hosts-icon-button"
                aria-label={`Remove ${name}`}
                title="Remove this host"
                onClick={() => {
                  if (window.confirm(`Remove ${name}? You can pair with it again later.`))
                    removeRemoteHost(entry.key)
                }}
              >
                <Trash2 size={16} />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
