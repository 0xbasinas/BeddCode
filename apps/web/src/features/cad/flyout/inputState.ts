/**
 * State for the in-viewport numeric box.
 *
 * The box doubles as a value readout during a drag and as a field the user
 * types into. The hard part is telling those two apart, so this module keeps
 * that decision pure and testable: `written` records what the box itself last
 * put in, and any other text means the user is typing.
 */

export interface NumericInputState {
  /** Text currently in the box. */
  text: string
  /** What the box last wrote itself, compared against to detect typing. */
  written: string
  /** Message under the box, shown when the current text will not parse. */
  error: string | null
  /** Whether the user has typed something the box did not write. */
  dirty: boolean
}

export interface NumericFieldOptions {
  label: string
  min?: number
  max?: number
  /** Units suffix shown next to the value, usually `mm`. */
  units?: string
  /** What Enter does with a parsed value. */
  onCommit(value: number): void
  /** Called on Escape and on blur without a commit. */
  onCancel?(): void
}

export const EMPTY_INPUT: NumericInputState = {
  text: '',
  written: '',
  error: null,
  dirty: false,
}

/** Three decimals, trailing zeros trimmed, so 12 and 12.5 both read naturally. */
export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 1000) / 1000
  return String(rounded)
}

/**
 * Parse typed text into a value inside `min`/`max`.
 * Returns the clamp reason instead of throwing so the box can show a tip.
 */
export function parseNumericText(
  text: string,
  options: Pick<NumericFieldOptions, 'min' | 'max'> = {},
): { value: number } | { error: string } {
  const trimmed = text.trim()
  if (trimmed === '') return { error: 'Enter a number' }
  const value = Number(trimmed)
  if (!Number.isFinite(value)) return { error: 'Not a number' }
  if (options.min !== undefined && value < options.min) {
    return { error: `At least ${formatNumber(options.min)}` }
  }
  if (options.max !== undefined && value > options.max) {
    return { error: `At most ${formatNumber(options.max)}` }
  }
  return { value }
}

/**
 * What the box should show after a drag reported a new value.
 *
 * Once the user has typed anything the box stops being a readout, so the next
 * drag step must not overwrite the number being typed. Comparing against
 * `written` rather than against focus is what makes that work while the drag
 * still holds focus.
 */
export function readoutText(
  state: NumericInputState,
  value: number,
): NumericInputState {
  if (state.dirty) return state
  const text = formatNumber(value)
  return { text, written: text, error: null, dirty: false }
}

/** Record text the user typed, re-evaluating the error tip. */
export function typedText(
  state: NumericInputState,
  text: string,
  options: Pick<NumericFieldOptions, 'min' | 'max'> = {},
): NumericInputState {
  const dirty = text !== state.written
  if (!dirty) return { ...state, text, error: null, dirty: false }
  const result = parseNumericText(text, options)
  return { text, written: state.written, error: 'error' in result ? result.error : null, dirty: true }
}

/** True when Enter should be accepted: something was typed and it parses. */
export function canCommit(
  state: NumericInputState,
  options: Pick<NumericFieldOptions, 'min' | 'max'> = {},
): boolean {
  if (!state.dirty) return false
  return 'value' in parseNumericText(state.text, options)
}

/** The value Enter would commit, or null when the text will not parse. */
export function commitValue(
  state: NumericInputState,
  options: Pick<NumericFieldOptions, 'min' | 'max'> = {},
): number | null {
  const result = parseNumericText(state.text, options)
  return 'value' in result ? result.value : null
}
