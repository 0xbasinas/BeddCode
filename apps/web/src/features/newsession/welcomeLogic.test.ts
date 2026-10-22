import { describe, expect, it } from 'vitest'
import { showWelcome } from './welcomeLogic.ts'

const firstRun = { synced: true, hasSessions: false, setupSkipped: false }

describe('showWelcome', () => {
  it('shows the checklist on a first run', () => {
    expect(showWelcome(firstRun)).toBe(true)
  })

  it("lets the sidebar's New session open the composer even on a first run", () => {
    expect(showWelcome({ ...firstRun, compose: true })).toBe(false)
  })

  it('steps aside for a picked folder, a skipped setup, existing sessions, or while loading', () => {
    expect(showWelcome({ ...firstRun, initialProject: '/w/demo' })).toBe(false)
    expect(showWelcome({ ...firstRun, setupSkipped: true })).toBe(false)
    expect(showWelcome({ ...firstRun, hasSessions: true })).toBe(false)
    expect(showWelcome({ ...firstRun, synced: false })).toBe(false)
  })
})
