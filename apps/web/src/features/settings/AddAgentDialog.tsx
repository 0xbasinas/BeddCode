import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, ChevronRight, Plus, Search, Trash2, X } from 'lucide-react'
import type { AcpAgentSummary, RegistryEntry } from '@beddcode/contracts'
import { hostRequest } from '../../stores/host.ts'
import { customAgentInput, type EnvironmentVariable } from './customAgent.ts'

export function AddAgentDialog({
  hostKey,
  agents,
  editing,
  onClose,
  onAdded,
}: {
  hostKey: string
  agents: AcpAgentSummary[]
  /** An agent already on this host: the form opens filled in and saves changes to it. */
  editing?: AcpAgentSummary
  onClose(): void
  onAdded(): void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState<'registry' | 'custom'>(editing ? 'custom' : 'registry')
  const [entries, setEntries] = useState<RegistryEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [registryError, setRegistryError] = useState<string>()
  const [retry, setRetry] = useState(0)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>()
  const [name, setName] = useState(editing?.label ?? '')
  const [command, setCommand] = useState(editing?.command ?? '')
  const [args, setArgs] = useState(editing?.args.join('\n') ?? '')
  const [variables, setVariables] = useState<EnvironmentVariable[]>(
    Object.entries(editing?.env ?? {}).map(([name, value]) => ({ name, value })),
  )
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  /** The user agreed to download the selected agent's program. */
  const [agreed, setAgreed] = useState(false)
  const entry = entries.find((e) => e.id === selected)
  const installed = new Set(agents.map((a) => a.registryId))
  const visible = entries.filter((e) =>
    `${e.name} ${e.description}`.toLowerCase().includes(query.toLowerCase()),
  )
  const canAdd =
    mode === 'custom'
      ? !!name.trim() && !!command.trim()
      : !!entry?.installable && !installed.has(entry.id) && (!entry.download || agreed)

  useEffect(() => {
    const element = dialog.current!
    const previous = document.activeElement
    element.showModal()
    return () => {
      element.close()
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  useEffect(() => {
    if (mode !== 'registry') return
    let cancelled = false
    setLoading(true)
    setRegistryError(undefined)
    hostRequest(hostKey, 'agents.registry', {}).then(
      (list) => {
        if (!cancelled) {
          setEntries(list)
          setLoading(false)
        }
      },
      (err: unknown) => {
        if (!cancelled) {
          setRegistryError(err instanceof Error ? err.message : String(err))
          setLoading(false)
        }
      },
    )
    return () => {
      cancelled = true
    }
  }, [hostKey, retry, mode])

  const add = async () => {
    setError(undefined)
    try {
      if (editing) {
        const input = customAgentInput(name, command, args, variables)
        setBusy(true)
        await hostRequest(hostKey, 'agents.update', {
          id: editing.id,
          label: input.label,
          command: input.command,
          args: input.args ?? [],
          env: input.env ?? {},
        })
        onAdded()
        return
      }
      const input =
        mode === 'custom'
          ? customAgentInput(name, command, args, variables)
          : { registryId: entry!.id, acceptDownload: entry!.download ? true : undefined }
      setBusy(true)
      await hostRequest(hostKey, 'agents.add', input)
      onAdded()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const setVariable = (index: number, patch: Partial<EnvironmentVariable>) =>
    setVariables((current) =>
      current.map((variable, i) => (i === index ? { ...variable, ...patch } : variable)),
    )

  return (
    <dialog
      ref={dialog}
      className="agent-dialog"
      aria-labelledby="add-agent-heading"
      onCancel={(e) => {
        e.preventDefault()
        if (!busy) onClose()
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (canAdd && !busy) void add()
        }}
      >
        <header className="agent-dialog-head">
          {mode === 'custom' && !editing && (
            <button
              type="button"
              className="icon-btn"
              aria-label="Back to agent registry"
              disabled={busy}
              onClick={() => {
                setMode('registry')
                setError(undefined)
              }}
            >
              <ArrowLeft size={17} />
            </button>
          )}
          <div>
            <h2 id="add-agent-heading">
              {editing ? 'Edit agent' : mode === 'custom' ? 'Custom agent' : 'Add an agent'}
            </h2>
            {mode === 'registry' && <p>Pick a coding agent to run on this host.</p>}
          </div>
          <button
            type="button"
            className="icon-btn"
            aria-label="Close add agent"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="agent-dialog-body">
          {mode === 'registry' ? (
            <>
              <label className="settings-search">
                <Search size={16} />
                <input
                  autoFocus
                  aria-label="Search agents"
                  placeholder="Search agents"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  disabled={busy}
                />
              </label>
              <div className="registry-list" role="radiogroup" aria-label="Registry agents">
                {loading && (
                  <p className="settings-empty" role="status">
                    Loading the ACP agent registry…
                  </p>
                )}
                {registryError && (
                  <div className="settings-error" role="alert">
                    <p>Could not load the agent registry. {registryError}</p>
                    <button
                      type="button"
                      className="settings-button"
                      onClick={() => setRetry((n) => n + 1)}
                    >
                      Try again
                    </button>
                  </div>
                )}
                {!loading && !registryError && visible.length === 0 && (
                  <p className="settings-empty">
                    No matching agents. You can add a custom command below.
                  </p>
                )}
                {visible.map((item) => (
                  <button
                    type="button"
                    key={item.id}
                    className={`registry-row ${selected === item.id ? 'selected' : ''}`}
                    role="radio"
                    aria-checked={selected === item.id}
                    disabled={busy || !item.installable || installed.has(item.id)}
                    onClick={() => {
                      setSelected(item.id)
                      setAgreed(false)
                    }}
                  >
                    <span className="agent-avatar">{item.name.slice(0, 2).toUpperCase()}</span>
                    <span className="setting-label">
                      <span>{item.name}</span>
                      <small>{item.description}</small>
                      {item.installable && item.download && <small>Downloads a program</small>}
                      {!item.installable && (
                        <small>
                          {item.reason ?? 'This agent needs a separate binary installation.'}
                        </small>
                      )}
                    </span>
                    <span className="registry-version">
                      {installed.has(item.id) ? 'Added' : item.version}
                    </span>
                  </button>
                ))}
              </div>
              {entry?.download && (
                <div className="settings-notice download-notice" role="group" aria-label="Download">
                  <p>
                    <strong>{entry.name}</strong> is a program that is downloaded from{' '}
                    <code>{entry.download.host}</code> and run on this host.{' '}
                    {entry.download.verified
                      ? 'The download is checked against a checksum the registry publishes.'
                      : 'The registry publishes no checksum for it, so the download cannot be verified.'}
                  </p>
                  <label className="download-agree">
                    <input
                      type="checkbox"
                      checked={agreed}
                      disabled={busy}
                      onChange={(e) => setAgreed(e.target.checked)}
                    />
                    Download and install it
                  </label>
                </div>
              )}
              <button
                type="button"
                className="custom-agent-link"
                disabled={busy}
                onClick={() => {
                  setMode('custom')
                  setError(undefined)
                }}
              >
                <span className="agent-avatar">
                  <Plus size={18} />
                </span>
                <span className="setting-label">
                  <span>Custom agent</span>
                  <small>Run a command that speaks Agent Client Protocol.</small>
                </span>
                <ChevronRight size={16} />
              </button>
            </>
          ) : (
            <fieldset disabled={busy} className="custom-agent-fields">
              <label>
                Name
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="My agent"
                  required
                />
              </label>
              <label>
                Command
                <input
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="goose"
                  required
                />
                <small>Executable name or absolute path on this host, without quotes.</small>
              </label>
              <label>
                Arguments
                <textarea
                  value={args}
                  onChange={(e) => setArgs(e.target.value)}
                  placeholder={'acp\n--model\nmy-model'}
                  rows={3}
                />
                <small>
                  One argument per line. Spaces within a line stay in the same argument.
                </small>
              </label>
              <div className="settings-section-head">
                <h3>Environment</h3>
                <button
                  type="button"
                  className="settings-button"
                  onClick={() => setVariables((current) => [...current, { name: '', value: '' }])}
                >
                  <Plus size={13} /> Add variable
                </button>
              </div>
              {variables.map((variable, i) => (
                <div className="environment-row" key={i}>
                  <input
                    aria-label={`Variable ${i + 1} name`}
                    placeholder="NAME"
                    value={variable.name}
                    onChange={(e) => setVariable(i, { name: e.target.value })}
                  />
                  <input
                    aria-label={`Variable ${i + 1} value`}
                    placeholder="Value"
                    type="password"
                    autoComplete="off"
                    value={variable.value}
                    onChange={(e) => setVariable(i, { value: e.target.value })}
                  />
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Remove variable ${i + 1}`}
                    onClick={() =>
                      setVariables((current) => current.filter((_, index) => index !== i))
                    }
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
            </fieldset>
          )}
          {error && (
            <p className="settings-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="agent-dialog-foot">
          <button type="button" className="settings-button" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="settings-button primary" type="submit" disabled={busy || !canAdd}>
            {editing
              ? busy
                ? 'Saving…'
                : 'Save changes'
              : busy
                ? entry?.download && mode === 'registry'
                  ? 'Downloading…'
                  : 'Adding…'
                : 'Add agent'}
          </button>
        </footer>
      </form>
    </dialog>
  )
}
