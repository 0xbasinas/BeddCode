import { beforeEach, describe, expect, it } from 'vitest'
import { projectDraftId } from '../../stores/composerWorkspace.ts'
import { composerDraftKey, useComposerDrafts } from './drafts.ts'

beforeEach(() => useComposerDrafts.setState({ drafts: {}, lastNewSession: undefined }))

describe('composer drafts', () => {
  it('keeps chats, new-session folders and hosts separate, and clears only the sent draft', () => {
    const chat = composerDraftKey('local', 'a')
    const a = composerDraftKey('local', projectDraftId('a'))
    const b = composerDraftKey('local', projectDraftId('b'))
    const remote = composerDraftKey('remote', projectDraftId('a'))
    const { setDraft, rememberNewSession } = useComposerDrafts.getState()
    setDraft(chat, 'Existing chat')
    setDraft(a, 'First task')
    setDraft(b, 'Second task')
    setDraft(remote, 'Remote task')
    rememberNewSession({ hostKey: 'local', folder: 'a' })
    rememberNewSession({ hostKey: 'remote', folder: 'a' })
    expect(useComposerDrafts.getState().drafts[a]).toBe('First task')
    expect(useComposerDrafts.getState().lastNewSession).toEqual({ hostKey: 'remote', folder: 'a' })
    setDraft(a, '')
    expect(useComposerDrafts.getState().drafts).toEqual({
      [chat]: 'Existing chat',
      [b]: 'Second task',
      [remote]: 'Remote task',
    })
  })

  it('recovers a failed send after leaving the composer without overwriting newer text', () => {
    const key = composerDraftKey('local', projectDraftId('failed-send'))
    const other = composerDraftKey('local', projectDraftId('other-folder'))
    const { setDraft, restoreDraft } = useComposerDrafts.getState()
    setDraft(key, 'Original message')
    setDraft(key, '')
    setDraft(other, 'Another task')
    restoreDraft(key, 'Original message')
    expect(useComposerDrafts.getState().drafts[key]).toBe('Original message')
    expect(useComposerDrafts.getState().drafts[other]).toBe('Another task')
    setDraft(key, 'Newer message')
    restoreDraft(key, 'Original message')
    expect(useComposerDrafts.getState().drafts[key]).toBe('Newer message')
  })
})

it('forgets the drafts of deleted sessions', () => {
  const kept = composerDraftKey('local', 'kept')
  const gone = composerDraftKey('local', 'gone')
  const { setDraft, dropDrafts } = useComposerDrafts.getState()
  setDraft(kept, 'Keep me')
  setDraft(gone, 'Delete me')
  dropDrafts([gone])
  expect(useComposerDrafts.getState().drafts).toEqual({ [kept]: 'Keep me' })
})
