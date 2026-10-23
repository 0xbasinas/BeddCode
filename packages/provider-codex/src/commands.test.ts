import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  codexPromptsDir,
  expandPrompt,
  parseSlash,
  scanCodexPrompts,
  splitArgs,
} from './commands.ts'

describe('Codex custom prompts', () => {
  it('fills positional, named and all-argument placeholders', () => {
    expect(expandPrompt('Do $1 then $2; all: $ARGUMENTS; cost $$5', 'a "b c"')).toBe(
      'Do a then b c; all: a b c; cost $5',
    )
    expect(expandPrompt('Ticket $TICKET for $1', 'TICKET=42 me')).toBe('Ticket 42 for me')
    expect(expandPrompt('---\ndescription: x\n---\nPlain prompt', 'extra words')).toBe(
      'Plain prompt\n\nextra words',
    )
    expect(expandPrompt('Plain', '')).toBe('Plain')
  })

  it('splits arguments and recognises commands', () => {
    expect(splitArgs(`one 'two three' "four"`)).toEqual(['one', 'two three', 'four'])
    expect(parseSlash('/prompts:fix 1 2')).toEqual({ name: 'prompts:fix', args: '1 2' })
    expect(parseSlash('/compact')).toEqual({ name: 'compact', args: '' })
    expect(parseSlash('hello /compact')).toBeNull()
  })

  it('lists prompt files with their description and argument hint', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'codex-prompts-'))
    writeFileSync(path.join(dir, 'b.md'), '# Second one\nbody')
    writeFileSync(
      path.join(dir, 'a.md'),
      '---\ndescription: "First"\nargument-hint: <x>\n---\nbody',
    )
    writeFileSync(path.join(dir, 'notes.txt'), 'ignored')
    expect(scanCodexPrompts(dir)).toEqual([
      { name: 'prompts:a', description: 'First', hint: '<x>', kind: 'command' },
      { name: 'prompts:b', description: 'Second one', hint: undefined, kind: 'command' },
    ])
    expect(scanCodexPrompts(path.join(dir, 'missing'))).toEqual([])
    rmSync(dir, { recursive: true, force: true })
  })

  it('reads prompts from CODEX_HOME when it is set', () => {
    expect(codexPromptsDir({ CODEX_HOME: '/c' }, '/home/u')).toBe(path.join('/c', 'prompts'))
    expect(codexPromptsDir({}, '/home/u')).toBe(path.join('/home/u', '.codex', 'prompts'))
  })
})
