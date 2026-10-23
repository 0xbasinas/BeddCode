import { describe, expect, it } from 'vitest'
import { doneMenuAction, doneOpen, isFiledAway, splitDone } from './doneSessions.ts'

const s = (id: string, status: 'idle' | 'running' | 'needs-you' | 'failed', done?: boolean) => ({
  id,
  status,
  done,
})

describe('isFiledAway', () => {
  it('needs the choice and a session that is not doing anything', () => {
    expect(isFiledAway(s('a', 'idle', true))).toBe(true)
    expect(isFiledAway(s('a', 'idle'))).toBe(false)
    expect(isFiledAway(s('a', 'running', true))).toBe(false)
    expect(isFiledAway(s('a', 'needs-you', true))).toBe(false)
  })
})

describe('splitDone', () => {
  it('keeps the order within each part', () => {
    const list = [
      s('1', 'idle'),
      s('2', 'idle', true),
      s('3', 'running', true),
      s('4', 'idle', true),
    ]
    const { active, done } = splitDone(list)
    expect(active.map((x) => x.id)).toEqual(['1', '3'])
    expect(done.map((x) => x.id)).toEqual(['2', '4'])
  })
})

describe('doneMenuAction', () => {
  it('offers to file a finished session, and to bring one back', () => {
    expect(doneMenuAction(s('a', 'idle'))).toEqual({ kind: 'file', label: 'Move to Done' })
    expect(doneMenuAction(s('a', 'idle', true))).toMatchObject({ kind: 'restore' })
    expect(doneMenuAction(s('a', 'failed'))).toMatchObject({ kind: 'file' })
  })
  it('says why a busy session cannot be filed', () => {
    expect(doneMenuAction(s('a', 'running'))).toMatchObject({
      kind: 'busy',
      hint: 'It is still working',
    })
    expect(doneMenuAction(s('a', 'needs-you'))).toMatchObject({
      kind: 'busy',
      hint: 'It is waiting for you',
    })
  })
})

describe('doneOpen', () => {
  const done = [{ id: 'x' }, { id: 'y' }]
  it('is closed unless asked, searching, or holding the open session', () => {
    expect(doneOpen({ chosen: false, searching: false, done })).toBe(false)
    expect(doneOpen({ chosen: true, searching: false, done })).toBe(true)
    expect(doneOpen({ chosen: false, searching: true, done })).toBe(true)
    expect(doneOpen({ chosen: false, searching: false, activeId: 'y', done })).toBe(true)
    expect(doneOpen({ chosen: false, searching: false, activeId: 'z', done })).toBe(false)
  })
})
