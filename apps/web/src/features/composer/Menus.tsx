import { ModelIcon } from '../../ui/AgentMark.tsx'
import { Check, ChevronDown, Shield } from 'lucide-react'
import type { ModelOption } from '@beddcode/contracts'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { effortLabel } from '../../ui/format.ts'
import { modelChoice, modelEfforts } from '../../ui/models.ts'

export interface ModeItem {
  id: string
  label: string
  description?: string
  dangerous?: boolean
}

/** The agent's own permission modes. Dangerous ("no prompts") modes are set apart and amber. */
export function ModeMenu({
  modes,
  modeId,
  onChange,
}: {
  modes: ModeItem[]
  modeId: string | undefined
  onChange(id: string): void
}) {
  const current = modes.find((m) => m.id === modeId) ?? modes[0]
  if (!current) return null
  const safe = modes.filter((m) => !m.dangerous)
  const dangerous = modes.filter((m) => m.dangerous)

  const row = (m: ModeItem, close: () => void) => (
    <button
      key={m.id}
      role="menuitemradio"
      aria-checked={m.id === current.id}
      className={`menu-row ${m.dangerous ? 'danger' : ''}`}
      onClick={() => {
        onChange(m.id)
        close()
      }}
    >
      <span className="menu-text">
        <span className="menu-title">{m.label}</span>
        {m.description && <span className="menu-desc">{m.description}</span>}
      </span>
      {m.id === current.id && <Check size={16} />}
    </button>
  )

  return (
    <Dropdown
      trigger={({ toggle }) => (
        <button
          className={`pill ${current.dangerous ? 'danger' : ''}`}
          onClick={toggle}
          aria-label="Permission mode"
        >
          <Shield size={15} /> {current.label} <ChevronDown size={14} />
        </button>
      )}
    >
      {(close) => (
        <>
          {safe.map((m) => row(m, close))}
          {dangerous.length > 0 && <div className="menu-sep" />}
          {dangerous.map((m) => row(m, close))}
        </>
      )}
    </Dropdown>
  )
}

export interface ModelChoice {
  model: string | undefined
  effort: string | undefined
}

/** Model and effort for a new session. Only offered when the agent lets the user choose. */
export function ModelMenu({
  models,
  efforts,
  value,
  onChange,
  agent,
}: {
  models: ModelOption[]
  efforts: string[]
  value: ModelChoice
  onChange(next: ModelChoice): void
  agent?: string
}) {
  if (models.length === 0 && efforts.length === 0) return null
  const model = models.find((m) => m.id === value.model)
  const label = model?.label ?? 'Default model'
  const availableEfforts = modelEfforts(models, efforts, value.model)

  return (
    <Dropdown
      align="end"
      panelClassName="wide"
      trigger={({ open, toggle }) => (
        <button
          className="pill"
          onClick={toggle}
          aria-label="Model and effort"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <ModelIcon agent={agent} /> {label}
          {value.effort && <span className="muted">{effortLabel(value.effort)}</span>}
          <ChevronDown size={14} />
        </button>
      )}
    >
      {() => (
        <>
          {models.length > 0 && (
            <>
              <div className="menu-heading">Model</div>
              <button
                className="menu-row"
                role="menuitemradio"
                aria-checked={!value.model}
                onClick={() =>
                  onChange(modelChoice(models, efforts, { ...value, model: undefined }))
                }
              >
                <span className="menu-text">
                  <span className="menu-title">Default</span>
                  <span className="menu-desc">Whatever the agent is set to use</span>
                </span>
                {!value.model && <Check size={16} />}
              </button>
              {models.map((m) => (
                <button
                  key={m.id}
                  className="menu-row"
                  role="menuitemradio"
                  aria-checked={m.id === value.model}
                  onClick={() => onChange(modelChoice(models, efforts, { ...value, model: m.id }))}
                >
                  <span className="menu-text">
                    <span className="menu-title">{m.label}</span>
                    {m.description && <span className="menu-desc">{m.description}</span>}
                  </span>
                  {m.id === value.model && <Check size={16} />}
                </button>
              ))}
            </>
          )}
          {models.length === 0 && (
            <>
              <div className="menu-heading">Model</div>
              <div className="menu-model-default">
                <span>Agent default</span>
                <span className="menu-desc">
                  Model choices are unavailable. Refresh agents in Settings to retry.
                </span>
              </div>
            </>
          )}
          {availableEfforts.length > 0 && (
            <>
              <div className="menu-sep" />
              <div className="menu-heading">
                Effort <span className="muted">Higher uses more of your limit</span>
              </div>
              <div className="segmented" role="radiogroup" aria-label="Effort">
                <button
                  role="radio"
                  aria-checked={!value.effort}
                  className={!value.effort ? 'on' : ''}
                  onClick={() => onChange({ ...value, effort: undefined })}
                >
                  Default
                </button>
                {availableEfforts.map((e) => (
                  <button
                    key={e}
                    role="radio"
                    aria-checked={e === value.effort}
                    className={e === value.effort ? 'on' : ''}
                    onClick={() => onChange({ ...value, effort: e })}
                  >
                    {effortLabel(e)}
                  </button>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </Dropdown>
  )
}

/** What a running session was started with. Changing it mid-session is not supported yet. */
export function ModelBadge({
  models,
  model,
  effort,
  agent,
}: {
  models: ModelOption[]
  model?: string
  effort?: string
  agent?: string
}) {
  if (!model && !effort) return null
  const label = models.find((m) => m.id === model)?.label ?? model ?? 'Default model'
  return (
    <span className="pill static" title="Chosen when the session started">
      <ModelIcon agent={agent} /> {label}
      {effort && <span className="muted">{effortLabel(effort)}</span>}
    </span>
  )
}
