import { Check, ChevronDown, Sparkles } from 'lucide-react'
import type { ConfigOption } from '@beddcode/contracts'
import { Dropdown } from '../../ui/Dropdown.tsx'

/** What a select option's current value is called, falling back to the raw value. */
export function valueLabel(option: ConfigOption): string {
  if (option.type === 'boolean') return option.value ? 'On' : 'Off'
  return option.choices?.find((c) => c.value === option.value)?.name ?? String(option.value)
}

/**
 * The agent's own per-session settings (its model, thinking level, ...), as the agent offers them.
 * Selects open a list of its choices; on/off settings flip with a click.
 */
export function ConfigMenu({
  options,
  disabled,
  onChange,
}: {
  options: ConfigOption[]
  disabled?: boolean
  onChange(optionId: string, value: string | boolean): void | Promise<void>
}) {
  if (options.length === 0) return null
  return (
    <>
      {options.map((option) =>
        option.type === 'boolean' ? (
          <button
            key={option.id}
            className="pill"
            role="switch"
            aria-checked={option.value === true}
            disabled={disabled}
            title={option.description}
            onClick={() => void onChange(option.id, option.value !== true)}
          >
            {option.name} <span className="muted">{valueLabel(option)}</span>
          </button>
        ) : (
          <Dropdown
            key={option.id}
            align="end"
            panelClassName="wide"
            trigger={({ open, toggle }) => (
              <button
                className="pill"
                onClick={toggle}
                disabled={disabled}
                aria-label={option.name}
                aria-haspopup="menu"
                aria-expanded={open}
                title={option.description ?? option.name}
              >
                {option.category === 'model' && <Sparkles size={15} />}
                {option.category === 'model' ? (
                  valueLabel(option)
                ) : (
                  <>
                    {option.name} <span className="muted">{valueLabel(option)}</span>
                  </>
                )}
                <ChevronDown size={14} />
              </button>
            )}
          >
            {(close) => (
              <>
                <div className="menu-heading">{option.name}</div>
                {(option.choices ?? []).map((choice, i, all) => (
                  <div key={choice.value}>
                    {choice.group && all[i - 1]?.group !== choice.group && (
                      <div className="menu-heading muted">{choice.group}</div>
                    )}
                    <button
                      className="menu-row"
                      role="menuitemradio"
                      aria-checked={choice.value === option.value}
                      onClick={() => {
                        void onChange(option.id, choice.value)
                        close()
                      }}
                    >
                      <span className="menu-text">
                        <span className="menu-title">{choice.name}</span>
                        {choice.description && (
                          <span className="menu-desc">{choice.description}</span>
                        )}
                      </span>
                      {choice.value === option.value && <Check size={16} />}
                    </button>
                  </div>
                ))}
              </>
            )}
          </Dropdown>
        ),
      )}
    </>
  )
}
