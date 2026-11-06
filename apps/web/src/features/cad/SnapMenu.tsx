import { useEffect, useRef, useState } from 'react'
import {
  DEFAULT_SNAP_SETTINGS,
  SNAP_LABELS,
  SNAP_TOGGLES,
  type SnapSettings,
  type SnapToggle,
} from './sketcher/snap.ts'

export interface SnapConfig {
  enabled: boolean
  settings: SnapSettings
}

export const DEFAULT_SNAP_CONFIG: SnapConfig = {
  enabled: true,
  settings: DEFAULT_SNAP_SETTINGS,
}

/** How many kinds are on, for the button's summary text. */
export function snapSummary(config: SnapConfig): string {
  if (!config.enabled) return 'Snap off'
  const on = SNAP_TOGGLES.filter((kind) => config.settings[kind]).length
  if (on === SNAP_TOGGLES.length) return 'Snap all'
  if (on === 0) return 'Snap grid'
  return `Snap ${on}/${SNAP_TOGGLES.length}`
}

/**
 * Per-kind snap switches, in the spirit of Chili3D's status bar snap config.
 * Lives in the status bar so it is reachable while sketching without leaving
 * the viewport.
 */
export function SnapMenu({
  config,
  onChange,
}: {
  config: SnapConfig
  onChange(next: SnapConfig): void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Clicking away closes the popover, matching a menu.
  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      const root = rootRef.current
      if (root && event.target instanceof Node && !root.contains(event.target)) setOpen(false)
    }
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const setKind = (kind: SnapToggle, value: boolean) => {
    onChange({ ...config, settings: { ...config.settings, [kind]: value } })
  }

  return (
    <div className="cad-snap" ref={rootRef}>
      <button
        type="button"
        className="cad-snap-summary"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Snap settings"
        title="Snap settings"
        onClick={() => setOpen((value) => !value)}
      >
        {snapSummary(config)}
      </button>
      {open ? (
        <div className="cad-snap-menu" role="menu" aria-label="Snap settings">
          <label className="cad-snap-row cad-snap-master">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) => onChange({ ...config, enabled: event.target.checked })}
            />
            <span>Object snap</span>
          </label>
          <div className="cad-snap-sep" role="separator" />
          {SNAP_TOGGLES.map((kind) => (
            <label key={kind} className="cad-snap-row">
              <input
                type="checkbox"
                checked={config.settings[kind]}
                disabled={!config.enabled}
                onChange={(event) => setKind(kind, event.target.checked)}
              />
              <span>{SNAP_LABELS[kind]}</span>
            </label>
          ))}
          <div className="cad-snap-sep" role="separator" />
          <button
            type="button"
            className="cad-snap-reset"
            onClick={() => onChange(DEFAULT_SNAP_CONFIG)}
          >
            Reset all
          </button>
        </div>
      ) : null}
    </div>
  )
}
