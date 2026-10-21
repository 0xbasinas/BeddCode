import { describe, expect, it } from 'vitest'
import { useUiStore } from './ui.ts'

describe('ui store', () => {
  it('toggles a pane open and closed', () => {
    useUiStore.getState().togglePane('git')
    expect(useUiStore.getState().activePane).toBe('git')
    useUiStore.getState().togglePane('git')
    expect(useUiStore.getState().activePane).toBeNull()
  })
})
