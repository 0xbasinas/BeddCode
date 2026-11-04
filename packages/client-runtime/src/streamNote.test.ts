import { describe, expect, it } from 'vitest'
import { clearStreamNote, initialStreamNote, nextStreamNote } from './streamNote.ts'
import type { StreamState } from './hostClient.ts'

const run = (states: StreamState[]) => states.reduce(nextStreamNote, initialStreamNote)

describe('stream note', () => {
  it('shows nothing on the first connect', () => {
    expect(run(['reconnecting']).note).toBe('none')
    expect(run(['reconnecting', 'catching-up']).note).toBe('none')
    expect(run(['reconnecting', 'catching-up', 'live']).note).toBe('none')
  })

  it('shows reconnecting after a real drop', () => {
    expect(run(['live', 'reconnecting']).note).toBe('reconnecting')
    expect(run(['live', 'reconnecting', 'catching-up']).note).toBe('reconnecting')
  })

  it('shows caught up when live returns after a reconnect', () => {
    expect(run(['live', 'reconnecting', 'catching-up', 'live']).note).toBe('caught-up')
    expect(run(['live', 'reconnecting', 'live']).note).toBe('caught-up')
  })

  it('clears caught up and stays quiet until the next reconnect', () => {
    const done = clearStreamNote(run(['live', 'reconnecting', 'live']))
    expect(done.note).toBe('none')
    expect(nextStreamNote(done, 'live').note).toBe('none')
    expect(nextStreamNote(done, 'reconnecting').note).toBe('reconnecting')
  })
})
