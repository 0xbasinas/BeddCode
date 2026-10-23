import { useEffect, useRef, useState } from 'react'
import { Sparkles } from 'lucide-react'
import type { RpcResult } from '@beddcode/contracts'
import { hostRequest, useRuntime } from '../../stores/host.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { Select } from '../../ui/Select.tsx'

export function GenerateGitText({
  sessionId,
  cwd,
  preferredInstanceId,
  kind,
  paths,
  base,
  disabled,
  onGenerated,
  onBusy,
}: {
  sessionId?: string
  cwd: string
  preferredInstanceId?: string
  kind: 'commit' | 'pr'
  paths?: string[]
  base?: string
  disabled?: boolean
  onGenerated(draft: RpcResult<'git.generate'>): void
  onBusy(busy: boolean): void
}) {
  const hostKey = useHostKey()
  const { providers, connection } = useRuntime(hostKey)
  const agents = providers.filter((p) => p.status === 'ready' && p.capabilities.textGeneration)
  const [chosen, setChosen] = useState<string>()
  const agent =
    agents.find((p) => p.id === chosen) ??
    agents.find((p) => p.id === preferredInstanceId) ??
    agents[0]
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const signature = JSON.stringify([hostKey, cwd, sessionId, agent?.id, kind, paths, base])
  const latest = useRef(signature)
  latest.current = signature
  const mounted = useRef(true)
  const busyCallback = useRef(onBusy)
  busyCallback.current = onBusy
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      busyCallback.current(false)
    }
  }, [])

  const generate = async () => {
    if (!agent || busy) return
    setBusy(true)
    onBusy(true)
    setError(undefined)
    setNotice(undefined)
    try {
      const draft = await hostRequest(hostKey, 'git.generate', {
        sessionId,
        cwd: sessionId ? undefined : cwd,
        instanceId: agent.id,
        kind,
        paths,
        base,
      })
      if (!mounted.current) return
      if (latest.current !== signature) {
        setNotice('The selection changed. Generate a new draft for these changes.')
        return
      }
      onGenerated(draft)
      if (draft.truncated)
        setNotice('Generated from part of a large diff. Review the draft before continuing.')
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) {
        setBusy(false)
        onBusy(false)
      }
    }
  }

  return (
    <div className="git-generation">
      <div className="git-generation-row">
        <button
          className="git-generate-action"
          aria-label={kind === 'commit' ? 'Generate message' : 'Generate title & description'}
          disabled={disabled || busy || !agent || connection !== 'connected'}
          onClick={() => void generate()}
        >
          <Sparkles size={14} />
          <span>
            {busy ? 'Generating…' : kind === 'commit' ? 'Generate message' : 'Generate PR draft'}
          </span>
        </button>
        {agents.length > 0 && (
          <Select
            aria-label="Text generation agent"
            value={agent?.id}
            disabled={busy || disabled}
            onChange={(e) => setChosen(e.target.value)}
          >
            {agents.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </Select>
        )}
      </div>
      {!agents.length && (
        <div className="muted small">
          Set up and sign in to an agent on this host to generate a draft.
        </div>
      )}
      {error && (
        <div className="composer-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="muted small" role="status">
          {notice}
        </div>
      )}
    </div>
  )
}
