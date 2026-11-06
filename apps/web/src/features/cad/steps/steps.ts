/**
 * Step prompts for a multi-pick tool, in the spirit of Chili3D's MultistepCommand.
 *
 * A tool that needs several picks tells the user which one is next rather than
 * printing one flat sentence for the whole tool. Each step carries its own
 * prompt, the input it accepts, and whether it will take the pick it was given.
 */

export type StepInput = 'point' | 'face' | 'edge' | 'vertex' | 'solid' | 'sketch' | 'number'

export interface StepSpec {
  /** Stable id for the step. */
  id: string
  /** Sentence shown in the status bar. */
  prompt: string
  /** What a pick must be to satisfy this step. */
  accepts: readonly StepInput[]
  /** Extra line under the prompt, used once the step has been attempted. */
  tip?: string
  /**
   * Keep this step active instead of advancing past it. Used by tools with no
   * fixed number of picks, such as a polyline chain.
   */
  repeat?: boolean
}

export interface StepState {
  steps: readonly StepSpec[]
  /** Index of the step being asked for. Equal to `steps.length` when done. */
  index: number
  /** Why the last attempt was rejected, cleared on the next accepted pick. */
  rejection: string | null
}

export interface StepProgress {
  prompt: string
  /** `2 / 3` style counter, empty for a single-step tool. */
  counter: string
  tip: string | null
  done: boolean
}

export const NO_STEPS: readonly StepSpec[] = []

export function startSteps(steps: readonly StepSpec[]): StepState {
  return { steps, index: 0, rejection: null }
}

export function currentStep(state: StepState): StepSpec | null {
  return state.steps[state.index] ?? null
}

export function isDone(state: StepState): boolean {
  return state.index >= state.steps.length
}

/**
 * Try to satisfy the current step with an input of `kind`.
 * Returns the next state and, when the step completed, the step that was filled.
 */
export function acceptInput(
  state: StepState,
  kind: StepInput,
): { state: StepState; filled: StepSpec | null; reason: string | null } {
  const step = currentStep(state)
  if (!step) return { state, filled: null, reason: 'Nothing left to pick' }
  if (!step.accepts.includes(kind)) {
    const wanted = step.accepts.join(' or ')
    return {
      state: { ...state, rejection: `Needs a ${wanted}, got a ${kind}` },
      filled: null,
      reason: `Needs a ${wanted}, got a ${kind}`,
    }
  }
  // A repeating step stays put: the pick was taken, but more can follow.
  return {
    state: { ...state, index: step.repeat ? state.index : state.index + 1, rejection: null },
    filled: step,
    reason: null,
  }
}

/**
 * The step a count of placed points implies.
 *
 * Sketch tools report how many points they have, not what kind of pick landed,
 * so this maps that count onto the step list. A repeat step clamps to itself,
 * which is what keeps a polyline chain on one prompt.
 */
export function stepForPlaced(state: StepState, placed: number): StepState {
  if (state.steps.length === 0) return state
  if (placed <= 0) return state.index === 0 ? state : { ...state, index: 0, rejection: null }
  const last = state.steps.length - 1
  const index = Math.min(placed - 1, last)
  return index === state.index ? state : { ...state, index, rejection: null }
}

/** Go back a step, so a mis-pick does not force the tool to restart. */
export function undoStep(state: StepState): StepState {
  if (state.index === 0) return state
  return { ...state, index: state.index - 1, rejection: null }
}

/** What the status bar shows for the current position. */
export function stepProgress(state: StepState): StepProgress {
  const step = currentStep(state)
  if (!step) {
    return { prompt: 'Done', counter: '', tip: null, done: true }
  }
  const counter = state.steps.length > 1 ? `${state.index + 1} / ${state.steps.length}` : ''
  const tip = state.rejection ?? step.tip ?? null
  return { prompt: step.prompt, counter, tip, done: false }
}
