import { describe, expect, it } from 'vitest'
import type { TerminalInfo } from '@beddcode/contracts'
import { placeTerminal } from './terminalTabs.ts'

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
