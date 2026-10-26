import { beforeEach, describe, expect, it } from 'vitest'
import {
  readingPosition,
  rememberReadingPosition,
  threadKey,
  useThreadDrafts,
} from './threadState.ts'

beforeEach(() => useThreadDrafts.setState({ drafts: {} }))

describe('chat drafts', () => {
  it('keeps drafts separate across chats and hosts, and clears only the sent draft', () => {
    const a = threadKey('local', 'a')
    const b = threadKey('local', 'b')
    const remote = threadKey('remote', 'a')
    const { setDraft } = useThreadDrafts.getState()
    setDraft(a, 'First task')
    setDraft(b, 'Second task')
    setDraft(remote, 'Remote task')
    expect(useThreadDrafts.getState().drafts[a]).toBe('First task')
    setDraft(a, '')
    expect(useThreadDrafts.getState().drafts).toEqual({
      [b]: 'Second task',
      [remote]: 'Remote task',
    })
  })

  it('recovers a failed send after switching chats without overwriting newer text', () => {
    const key = threadKey('local', 'failed-send')
    const { setDraft, restoreDraft } = useThreadDrafts.getState()
    setDraft(key, 'Original message')
    setDraft(key, '')
    restoreDraft(key, 'Original message')
    expect(useThreadDrafts.getState().drafts[key]).toBe('Original message')
    setDraft(key, 'Newer message')
    restoreDraft(key, 'Original message')
    expect(useThreadDrafts.getState().drafts[key]).toBe('Newer message')
  })
})

describe('chat reading position', () => {
  it('remembers earlier messages along with the scroll position independently per chat', () => {
    const a = threadKey('local', 'reading-a')
    const b = threadKey('local', 'reading-b')
    rememberReadingPosition(a, { from: 12 })
    rememberReadingPosition(a, { top: 850, following: false })
    rememberReadingPosition(b, { top: 2000, following: true })
    expect(readingPosition(a)).toEqual({ from: 12, top: 850, following: false })
    expect(readingPosition(b)).toEqual({ top: 2000, following: true })
    rememberReadingPosition(a, { following: true })
    expect(readingPosition(a)?.from).toBe(12)
    expect(readingPosition(a)?.following).toBe(true)
  })
})
