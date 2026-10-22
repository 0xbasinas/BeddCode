import { describe, expect, it, vi } from 'vitest'
import { loadPaneState, useUiStore } from './ui.ts'

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

  it('collapses to the rail and expands on the tool it last showed', () => {
    const ui = () => useUiStore.getState()
    ui().openPane('terminal')
    expect(ui()).toMatchObject({ activePane: 'terminal', paneCollapsed: false })
    ui().collapsePane()
    expect(ui()).toMatchObject({ activePane: null, paneCollapsed: true, lastPane: 'terminal' })
    ui().togglePaneCollapsed()
    expect(ui()).toMatchObject({ activePane: 'terminal', paneCollapsed: false })
    // A rail icon while collapsed expands on that tool; on the tool showing, it collapses.
    ui().collapsePane()
    ui().togglePane('files')
    expect(ui()).toMatchObject({ activePane: 'files', paneCollapsed: false })
    ui().togglePane('git')
    expect(ui().activePane).toBe('git')
    ui().togglePane('git')
    expect(ui()).toMatchObject({ activePane: null, paneCollapsed: true, lastPane: 'git' })
    // "Changes" expands a collapsed pane.
    ui().showChanges()
    expect(ui()).toMatchObject({ activePane: 'git', paneCollapsed: false, gitTab: 'changes' })
  })

  it('remembers the collapsed state and tool between runs', () => {
    const data = new Map<string, string>()
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
    expect(loadPaneState(store)).toEqual({ lastPane: 'git', paneCollapsed: true })
    data.set('beddcode.right-pane', JSON.stringify({ lastPane: 'browser', paneCollapsed: false }))
    expect(loadPaneState(store)).toEqual({ lastPane: 'browser', paneCollapsed: false })
    data.set('beddcode.right-pane', '{"lastPane":"nope","paneCollapsed":"x"}')
    expect(loadPaneState(store)).toEqual({ lastPane: 'git', paneCollapsed: true })
    data.set('beddcode.right-pane', 'not json')
    expect(loadPaneState(store)).toEqual({ lastPane: 'git', paneCollapsed: true })
  })

  it('saves what it changes', () => {
    const data = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    })
    try {
      useUiStore.getState().openPane('browser')
      expect(JSON.parse(data.get('beddcode.right-pane')!)).toEqual({
        lastPane: 'browser',
        paneCollapsed: false,
      })
      useUiStore.getState().collapsePane()
      expect(JSON.parse(data.get('beddcode.right-pane')!)).toEqual({
        lastPane: 'browser',
        paneCollapsed: true,
      })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
