import { describe, expect, it } from 'vitest'
import {
  acceptInput,
  currentStep,
  isDone,
  startSteps,
  stepForPlaced,
  stepProgress,
  undoStep,
  type StepSpec,
} from './steps.ts'
import { stepsFor } from './toolSteps.ts'

const TWO: readonly StepSpec[] = [
  { id: 'a', prompt: 'Pick A', accepts: ['face'] },
  { id: 'b', prompt: 'Pick B', accepts: ['edge'], tip: 'shift-click for more' },
]

describe('startSteps', () => {
  it('begins on the first step with no rejection', () => {
    const state = startSteps(TWO)
    expect(state.index).toBe(0)
    expect(state.rejection).toBeNull()
    expect(currentStep(state)?.id).toBe('a')
  })
})

describe('acceptInput', () => {
  it('advances when the input matches', () => {
    const { state, filled, reason } = acceptInput(startSteps(TWO), 'face')
    expect(filled?.id).toBe('a')
    expect(reason).toBeNull()
    expect(state.index).toBe(1)
  })

  it('rejects the wrong input and says what it wanted', () => {
    const { state, filled, reason } = acceptInput(startSteps(TWO), 'edge')
    expect(filled).toBeNull()
    expect(state.index).toBe(0)
    expect(reason).toBe('Needs a face, got a edge')
    expect(state.rejection).toBe('Needs a face, got a edge')
  })

  it('clears the rejection once a good pick lands', () => {
    const first = acceptInput(startSteps(TWO), 'edge').state
    const second = acceptInput(first, 'face')
    expect(second.state.rejection).toBeNull()
  })

  it('reports nothing left once done', () => {
    const done = { ...startSteps(TWO), index: 2 }
    expect(acceptInput(done, 'edge').reason).toBe('Nothing left to pick')
  })
})

describe('undoStep', () => {
  it('steps back and clears the rejection', () => {
    const bad = acceptInput(startSteps(TWO), 'edge').state
    const back = undoStep({ ...bad, index: 1 })
    expect(back.index).toBe(0)
    expect(back.rejection).toBeNull()
  })

  it('will not go below zero', () => {
    expect(undoStep(startSteps(TWO)).index).toBe(0)
  })
})

describe('stepProgress', () => {
  it('shows a counter only for multi-step tools', () => {
    expect(stepProgress(startSteps(TWO)).counter).toBe('1 / 2')
    const single = startSteps([{ id: 'one', prompt: 'Pick a face', accepts: ['face'] }])
    expect(stepProgress(single).counter).toBe('')
  })

  it('prefers the rejection over the step tip', () => {
    const state = acceptInput({ ...startSteps(TWO), index: 1 }, 'face').state
    expect(stepProgress(state).tip).toBe('Needs a edge, got a face')
  })

  it('falls back to the step tip', () => {
    const state = { ...startSteps(TWO), index: 1 }
    expect(stepProgress(state).tip).toBe('shift-click for more')
  })

  it('marks done when the steps run out', () => {
    const done = stepProgress({ ...startSteps(TWO), index: 2 })
    expect(done.done).toBe(true)
    expect(isDone({ ...startSteps(TWO), index: 2 })).toBe(true)
  })
})

describe('stepsFor', () => {
  it('gives fillet a single edge step, since it forces the edge filter', () => {
    expect(stepsFor('fillet').map((step) => step.id)).toEqual(['edges'])
    expect(stepsFor('chamfer').map((step) => step.id)).toEqual(['edges'])
  })

  it('gives booleans a target then a tool', () => {
    expect(stepsFor('cut').map((step) => step.id)).toEqual(['target', 'tool'])
  })

  it('varies sketch steps by sub-tool', () => {
    expect(stepsFor('sketch', 'rectangle')).toHaveLength(2)
    expect(stepsFor('sketch', 'arc')).toHaveLength(3)
    expect(stepsFor('sketch', 'line')).toHaveLength(2)
  })

  it('returns no steps for click-only tools', () => {
    expect(stepsFor('select')).toHaveLength(0)
    expect(stepsFor('export')).toHaveLength(0)
  })
})

describe('repeat steps', () => {
  const chain: readonly StepSpec[] = [
    { id: 'start', prompt: 'Pick the first point', accepts: ['point'] },
    { id: 'next', prompt: 'Keep chaining', accepts: ['point'], repeat: true },
  ]

  it('stays on a repeating step instead of running past it', () => {
    const first = acceptInput(startSteps(chain), 'point').state
    expect(first.index).toBe(1)
    const second = acceptInput(first, 'point').state
    expect(second.index).toBe(1)
    const third = acceptInput(second, 'point').state
    expect(third.index).toBe(1)
    expect(isDone(third)).toBe(false)
  })

  it('still advances past a non-repeating step', () => {
    const state = acceptInput(startSteps(TWO), 'face').state
    expect(state.index).toBe(1)
  })
})

describe('stepForPlaced', () => {
  const three: readonly StepSpec[] = [
    { id: 'a', prompt: 'A', accepts: ['point'] },
    { id: 'b', prompt: 'B', accepts: ['point'] },
    { id: 'c', prompt: 'C', accepts: ['point'] },
  ]

  it('maps a placed count to the step index', () => {
    expect(stepForPlaced(startSteps(three), 1).index).toBe(0)
    expect(stepForPlaced(startSteps(three), 2).index).toBe(1)
    expect(stepForPlaced(startSteps(three), 3).index).toBe(2)
  })

  it('clamps rather than running past the last step', () => {
    expect(stepForPlaced(startSteps(three), 9).index).toBe(2)
  })

  it('returns to the first step when the draft clears', () => {
    const atTwo = { ...startSteps(three), index: 2 }
    expect(stepForPlaced(atTwo, 0).index).toBe(0)
  })

  it('leaves a stepless tool alone', () => {
    const empty = startSteps([])
    expect(stepForPlaced(empty, 5)).toBe(empty)
  })
})
