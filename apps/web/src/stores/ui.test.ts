import { describe, expect, it } from 'vitest'
import { useUiStore } from './ui.ts'

describe('ui store', () => {
  it('toggles a pane open and closed', () => {
    useUiStore.getState().togglePane('git')
    expect(useUiStore.getState().activePane).toBe('git')
    useUiStore.getState().togglePane('git')
    expect(useUiStore.getState().activePane).toBeNull()
  })

  it('opens the Git pane on its Changes tab even when it showed another tab', () => {
    useUiStore.getState().openPane('git')
    useUiStore.getState().setGitTab('commits')
    useUiStore.getState().showChanges()
    expect(useUiStore.getState()).toMatchObject({ activePane: 'git', gitTab: 'changes' })
    // From another pane, too.
    useUiStore.getState().openPane('files')
    useUiStore.getState().showChanges()
    expect(useUiStore.getState().activePane).toBe('git')
  })

  it('starts with the Environment card closed and remembers it only in memory', () => {
    expect(useUiStore.getState().environmentOpen).toBe(false)
    useUiStore.getState().setEnvironmentOpen(true)
    expect(useUiStore.getState().environmentOpen).toBe(true)
    expect(globalThis.localStorage?.getItem('beddcode.environment-minimized') ?? null).toBeNull()
    useUiStore.getState().setEnvironmentOpen(false)
    expect(useUiStore.getState().environmentOpen).toBe(false)
  })
})
