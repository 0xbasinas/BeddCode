import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import {
  EMPTY_INPUT,
  canCommit,
  commitValue,
  readoutText,
  typedText,
  type NumericFieldOptions,
  type NumericInputState,
} from './inputState.ts'

/** Where the box sits, in viewport-relative pixels. */
export interface FlyoutAnchor {
  x: number
  y: number
}

/**
 * Floating numeric entry in the viewport, modelled on Chili3D's flyout.
 *
 * The value can arrive two ways: typed by the user, or pushed by an active drag
 * through `value`. Typing always wins, because `readoutText` refuses to
 * overwrite once the user has taken over the box.
 */
export function NumericFlyout({
  anchor,
  field,
  value,
  unitLabel,
  seed,
}: {
  anchor: FlyoutAnchor | null
  field: NumericFieldOptions
  /** Live value from a drag. Ignored once the user types. */
  value: number | null
  unitLabel?: string
  /** First character already typed, so the digit that opened the box is kept. */
  seed?: string
}) {
  const [state, setState] = useState<NumericInputState>(() => {
    const base = value === null ? EMPTY_INPUT : readoutText(EMPTY_INPUT, value)
    return seed ? typedText(base, seed, field) : base
  })
  const inputRef = useRef<HTMLInputElement | null>(null)
  const limits = { min: field.min, max: field.max }

  // Focus on open so a bare digit lands in the box.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.select()
    // Only on mount of this anchor: re-focusing on every anchor change would
    // fight the pointer during a drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A drag pushes a value in. It cannot win once the user is typing.
  useEffect(() => {
    if (value === null) return
    setState((current) => readoutText(current, value))
  }, [value])
  const commit = () => {
    const next = commitValue(state, limits)
    if (next === null) return
    field.onCommit(next)
    setState(EMPTY_INPUT)
  }

  const cancel = () => {
    setState(EMPTY_INPUT)
    field.onCancel?.()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      commit()
      return
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      cancel()
      return
    }
    // Arrow keys step the value, matching Chili3D's numeric box.
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      const current = commitValue(state, limits) ?? value ?? field.min ?? 0
      const step = event.shiftKey ? 10 : 1
      const next = current + (event.key === 'ArrowUp' ? step : -step)
      const clamped = Math.max(field.min ?? -Infinity, Math.min(field.max ?? Infinity, next))
      const text = String(Math.round(clamped * 1000) / 1000)
      setState(typedText(state, text, limits))
      return
    }
    // Everything else is ordinary editing; the pane's shortcuts stay quiet.
    event.stopPropagation()
  }

  const onChange = (raw: string) => {
    setState((current) => typedText(current, raw, limits))
  }

  const showError = state.error !== null && state.dirty

  return (
    <div
      className="cad-flyout"
      style={anchor ? { left: anchor.x, top: anchor.y } : undefined}
      role="group"
      aria-label={field.label}
    >
      <label className="cad-flyout-label">
        <span className="cad-flyout-caption">{field.label}</span>
        <input
          ref={inputRef}
          type="text"
          inputMode="decimal"
          className="cad-flyout-input"
          value={state.text}
          aria-invalid={showError}
          aria-label={field.label}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Blur only commits a valid typed value. A readout just closes.
            if (canCommit(state, limits)) commit()
            else cancel()
          }}
        />
        {unitLabel ? <span className="cad-flyout-units">{unitLabel}</span> : null}
      </label>
      {showError ? <p className="cad-flyout-tip is-error">{state.error}</p> : null}
      <p className="cad-flyout-hint">Enter applies, Esc cancels</p>
    </div>
  )
}
