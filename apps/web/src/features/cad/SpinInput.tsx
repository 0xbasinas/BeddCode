/**
 * Numeric property editor. Keystrokes stay in a local draft.
 * Enter and blur write one value. Escape restores the last committed number.
 * Step buttons and the wheel (while focused) write one small step. Shift is 10×.
 */

import { ChevronDown, ChevronUp } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'

/** One unit per click or wheel notch. Shift multiplies this by ten. */
export const SPIN_STEP = 1
const SHIFT_FACTOR = 10

export const SPIN_INVALID_MESSAGE = 'Enter a number'

export interface SpinEdit {
  committed: number
  /** `null` means the field is showing `committed`, not a draft. */
  draft: string | null
  error: string | null
}

export type SpinAction =
  | { type: 'type'; text: string }
  | { type: 'enter' }
  | { type: 'blur' }
  | { type: 'escape' }
  | { type: 'step'; direction: 1 | -1; shift: boolean }

export interface SpinEditResult {
  edit: SpinEdit
  /** Set when this gesture should write the model. Typing never sets it. */
  commit: number | null
}

export function spinEdit(committed: number): SpinEdit {
  return { committed: finite(committed), draft: null, error: null }
}

export function formatSpin(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 1e6) / 1e6
  if (Object.is(rounded, -0)) return '0'
  return String(rounded)
}

export function spinDisplay(edit: SpinEdit): string {
  return edit.draft ?? formatSpin(edit.committed)
}

/**
 * Blank and half-typed tokens (`-`, `1e`) are unfinished, so blur writes nothing.
 * Anything else that is not a plain decimal is invalid and stays on screen.
 */
export function classifySpinText(
  text: string,
): { kind: 'empty' } | { kind: 'invalid'; message: string } | { kind: 'number'; value: number } {
  const trimmed = text.trim()
  if (trimmed === '' || unfinished(trimmed)) return { kind: 'empty' }
  if (!DECIMAL.test(trimmed)) return { kind: 'invalid', message: SPIN_INVALID_MESSAGE }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { kind: 'invalid', message: SPIN_INVALID_MESSAGE }
  return { kind: 'number', value }
}

export function editSpin(edit: SpinEdit, action: SpinAction, step = SPIN_STEP, min = -Infinity): SpinEditResult {
  if (action.type === 'type') {
    return { edit: { ...edit, draft: action.text, error: null }, commit: null }
  }
  if (action.type === 'escape') {
    return { edit: { committed: edit.committed, draft: null, error: null }, commit: null }
  }
  if (action.type === 'step') {
    const next = Math.max(min, roundSpin(
      stepBase(edit) + action.direction * step * (action.shift ? SHIFT_FACTOR : 1),
    ))
    if (next === edit.committed) {
      return { edit: { committed: edit.committed, draft: null, error: null }, commit: null }
    }
    return { edit: { committed: next, draft: null, error: null }, commit: next }
  }
  if (edit.draft === null) return { edit: { ...edit, error: null }, commit: null }
  const parsed = classifySpinText(edit.draft)
  if (parsed.kind === 'empty') {
    return { edit: { committed: edit.committed, draft: null, error: null }, commit: null }
  }
  if (parsed.kind === 'invalid') {
    return { edit: { ...edit, error: parsed.message }, commit: null }
  }
  const next = Math.max(min, parsed.value)
  if (next === edit.committed) {
    return { edit: { committed: edit.committed, draft: null, error: null }, commit: null }
  }
  return { edit: { committed: next, draft: null, error: null }, commit: next }
}

const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/

function unfinished(text: string): boolean {
  if (text === '+' || text === '-' || text === '.' || text === '+.' || text === '-.') return true
  return /^[+-]?(?:\d+\.?\d*|\.\d+)[eE][+-]?$/.test(text)
}

function stepBase(edit: SpinEdit): number {
  if (edit.draft === null) return edit.committed
  const parsed = classifySpinText(edit.draft)
  return parsed.kind === 'number' ? parsed.value : edit.committed
}

function roundSpin(value: number): number {
  const rounded = Math.round(value * 1e6) / 1e6
  return Object.is(rounded, -0) ? 0 : rounded
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0
}

export function SpinInput({
  label,
  value,
  onCommit,
  step = SPIN_STEP,
  min,
  disabled = false,
  className = 'cad-field',
}: {
  label: string
  value: number
  onCommit(next: number): void
  step?: number
  min?: number
  disabled?: boolean
  className?: string
}) {
  const errorId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit

  const committed = finite(value)
  const [edit, setEdit] = useState(() => spinEdit(committed))
  const [seen, setSeen] = useState(committed)
  let view = edit
  if (committed !== seen) {
    setSeen(committed)
    view = view.draft === null ? spinEdit(committed) : { ...view, committed }
    setEdit(view)
  }
  const editRef = useRef(view)
  editRef.current = view

  const apply = (action: SpinAction) => {
    const result = editSpin(editRef.current, action, step, min)
    editRef.current = result.edit
    setEdit(result.edit)
    if (result.commit !== null) onCommitRef.current(result.commit)
  }
  const applyRef = useRef(apply)
  applyRef.current = apply

  useEffect(() => {
    const node = rootRef.current
    const input = inputRef.current
    if (!node || !input) return
    // The properties column scrolls. A passive listener cannot cancel that.
    const onWheel = (event: WheelEvent) => {
      if (document.activeElement !== input) return
      if (event.ctrlKey || event.metaKey || event.deltaY === 0) return
      event.preventDefault()
      event.stopPropagation()
      applyRef.current({
        type: 'step',
        direction: event.deltaY < 0 ? 1 : -1,
        shift: event.shiftKey,
      })
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => node.removeEventListener('wheel', onWheel)
  }, [])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation()
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Enter') {
      event.preventDefault()
      apply({ type: 'enter' })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      apply({ type: 'escape' })
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      apply({
        type: 'step',
        direction: event.key === 'ArrowUp' ? 1 : -1,
        shift: event.shiftKey,
      })
    }
  }

  const keepFocus = (event: PointerEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
  }

  return (
    <label className={className}>
      <span>{label}</span>
      <div
        className="cad-spin"
        ref={rootRef}
        data-invalid={view.error ? 'true' : undefined}
        onPointerDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          aria-label={label}
          disabled={disabled}
          value={spinDisplay(view)}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={view.error ? true : undefined}
          aria-describedby={view.error ? errorId : undefined}
          onChange={(event) => apply({ type: 'type', text: event.target.value })}
          onBlur={() => apply({ type: 'blur' })}
          onKeyDown={onKeyDown}
        />
        <div className="cad-spin-steps">
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={`Increase ${label}`}
            onMouseDown={keepFocus}
            onClick={(event) => apply({ type: 'step', direction: 1, shift: event.shiftKey })}
          >
            <ChevronUp size={10} />
          </button>
          <button
            type="button"
            tabIndex={-1}
            disabled={disabled}
            aria-label={`Decrease ${label}`}
            onMouseDown={keepFocus}
            onClick={(event) => apply({ type: 'step', direction: -1, shift: event.shiftKey })}
          >
            <ChevronDown size={10} />
          </button>
        </div>
      </div>
      {view.error ? (
        <span className="cad-field-error" id={errorId}>
          {view.error}
        </span>
      ) : null}
    </label>
  )
}
