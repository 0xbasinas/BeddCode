import { describe, expect, it } from 'vitest'
import { editSpin, spinDisplay, spinEdit, SPIN_INVALID_MESSAGE } from './SpinInput.tsx'

describe('spin field commit', () => {
  it('keeps each keystroke local until enter', () => {
    const first = editSpin(spinEdit(20), { type: 'type', text: '1' })
    const second = editSpin(first.edit, { type: 'type', text: '12' })
    expect(first.commit).toBeNull()
    expect(second.commit).toBeNull()
    expect(spinDisplay(second.edit)).toBe('12')
    const entered = editSpin(second.edit, { type: 'enter' })
    expect(entered.commit).toBe(12)
    expect(entered.edit.draft).toBeNull()
    expect(spinDisplay(entered.edit)).toBe('12')
  })

  it('commits 80 once after typing and does not repeat on blur', () => {
    const first = editSpin(spinEdit(20), { type: 'type', text: '8' })
    const second = editSpin(first.edit, { type: 'type', text: '80' })
    expect([first.commit, second.commit]).toEqual([null, null])
    const entered = editSpin(second.edit, { type: 'enter' })
    expect(entered.commit).toBe(80)
    expect(editSpin(entered.edit, { type: 'blur' }).commit).toBeNull()
  })

  it('clamps committed tool options to their minimum', () => {
    const typed = editSpin(spinEdit(8), { type: 'type', text: '-2' })
    expect(editSpin(typed.edit, { type: 'blur' }, 0.1, 0.1).commit).toBe(0.1)
    expect(editSpin(spinEdit(0.1), { type: 'step', direction: -1, shift: false }, 0.1, 0.1).commit).toBeNull()
  })

  it('commits the draft on blur', () => {
    const typed = editSpin(spinEdit(10), { type: 'type', text: '8.5' })
    const blurred = editSpin(typed.edit, { type: 'blur' })
    expect(blurred.commit).toBe(8.5)
    expect(spinDisplay(blurred.edit)).toBe('8.5')
  })

  it('escape restores the last committed value and writes nothing', () => {
    const typed = editSpin(spinEdit(10), { type: 'type', text: '99' })
    const reverted = editSpin(typed.edit, { type: 'escape' })
    expect(reverted.commit).toBeNull()
    expect(reverted.edit.error).toBeNull()
    expect(spinDisplay(reverted.edit)).toBe('10')
  })

  it('does not commit an untouched field or an unchanged draft', () => {
    expect(editSpin(spinEdit(3), { type: 'enter' }).commit).toBeNull()
    expect(editSpin(spinEdit(3), { type: 'blur' }).commit).toBeNull()
    const same = editSpin(spinEdit(10), { type: 'type', text: '10.0' })
    const blurred = editSpin(same.edit, { type: 'blur' })
    expect(blurred.commit).toBeNull()
    expect(blurred.edit.draft).toBeNull()
    expect(spinDisplay(blurred.edit)).toBe('10')
  })

  it('drops an empty or unfinished draft without writing', () => {
    const empty = editSpin(editSpin(spinEdit(4), { type: 'type', text: '' }).edit, { type: 'blur' })
    expect(empty.commit).toBeNull()
    expect(spinDisplay(empty.edit)).toBe('4')
    const minus = editSpin(editSpin(spinEdit(4), { type: 'type', text: '-' }).edit, {
      type: 'blur',
    })
    expect(minus.commit).toBeNull()
    expect(minus.edit.error).toBeNull()
    expect(spinDisplay(minus.edit)).toBe('4')
  })

  it('keeps invalid text and commits nothing until escape', () => {
    const typed = editSpin(spinEdit(4), { type: 'type', text: 'nope' })
    const blurred = editSpin(typed.edit, { type: 'blur' })
    expect(blurred.commit).toBeNull()
    expect(spinDisplay(blurred.edit)).toBe('nope')
    expect(blurred.edit.error).toBe(SPIN_INVALID_MESSAGE)
    const reverted = editSpin(blurred.edit, { type: 'escape' })
    expect(reverted.commit).toBeNull()
    expect(spinDisplay(reverted.edit)).toBe('4')
    expect(reverted.edit.error).toBeNull()
  })

  it('steps by one, and by ten while shift is held', () => {
    expect(editSpin(spinEdit(10), { type: 'step', direction: 1, shift: false }).commit).toBe(11)
    expect(editSpin(spinEdit(2), { type: 'step', direction: -1, shift: true }).commit).toBe(-8)
  })

  it('steps from the uncommitted number, or from the committed value when the draft is bad', () => {
    const typed = editSpin(spinEdit(10), { type: 'type', text: '3' })
    expect(editSpin(typed.edit, { type: 'step', direction: 1, shift: false }).commit).toBe(4)
    const bad = editSpin(spinEdit(5), { type: 'type', text: 'abc' })
    const stepped = editSpin(bad.edit, { type: 'step', direction: 1, shift: false })
    expect(stepped.commit).toBe(6)
    expect(spinDisplay(stepped.edit)).toBe('6')
    expect(stepped.edit.error).toBeNull()
  })

  it('accepts a trailing dot as that whole number', () => {
    const typed = editSpin(spinEdit(4), { type: 'type', text: '1.' })
    expect(editSpin(typed.edit, { type: 'enter' }).commit).toBe(1)
  })
})
