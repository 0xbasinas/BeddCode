import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '@beddcode/contracts'
import { applyTerminalChange, placeTerminal, shouldFollow } from './terminalTabs.ts'

const term = (id: string, scriptId?: string): TerminalInfo => ({
  id,
  cwd: '/x',
  shell: 'bash',
  cols: 80,
  rows: 24,
  createdAt: 0,
  ...(scriptId ? { scriptId } : {}),
})

describe('placeTerminal', () => {
  it('puts a script run again in its earlier tab, and anything else at the end', () => {
    const list = [term('a'), term('b', 'test'), term('c')]
    expect(placeTerminal(list, term('d', 'test')).map((t) => t.id)).toEqual(['a', 'd', 'c'])
    expect(placeTerminal(list, term('e', 'dev')).map((t) => t.id)).toEqual(['a', 'b', 'c', 'e'])
    expect(placeTerminal(list, term('f')).map((t) => t.id)).toEqual(['a', 'b', 'c', 'f'])
  })
})

const agentTab = (id: string, running?: string): TerminalInfo => ({
  ...term(id),
  readOnly: true,
  agent: { sessionId: 's', label: 'Grok', mode: 'pty', ...(running ? { running } : {}) },
})

describe('applyTerminalChange', () => {
  it('updates a tab in place, adds a new one and removes a closed one', () => {
    const list = [term('a'), agentTab('b'), term('c')]
    expect(
      applyTerminalChange(list, 'b', agentTab('b', 'ls')).map((t) => t.agent?.running),
    ).toEqual([undefined, 'ls', undefined])
    expect(applyTerminalChange(list, 'd', agentTab('d')).map((t) => t.id)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ])
    expect(applyTerminalChange(list, 'b', null).map((t) => t.id)).toEqual(['a', 'c'])
  })
})

describe('shouldFollow', () => {
  it('shows an agent tab when it appears or starts a command', () => {
    expect(shouldFollow(undefined, agentTab('b'), term('a'))).toBe(true)
    expect(shouldFollow(agentTab('b'), agentTab('b', 'ls'), agentTab('x'))).toBe(true)
    expect(shouldFollow(agentTab('b'), agentTab('b', 'ls'), undefined)).toBe(true)
  })

  it('leaves the user in their own shell, and ignores other changes', () => {
    expect(shouldFollow(agentTab('b'), agentTab('b', 'ls'), term('a'))).toBe(false)
    expect(shouldFollow(agentTab('b', 'ls'), agentTab('b', 'pwd'), agentTab('b'))).toBe(false)
    expect(shouldFollow(term('a'), term('a'), undefined)).toBe(false)
    expect(shouldFollow(agentTab('b'), null, undefined)).toBe(false)
  })
})
