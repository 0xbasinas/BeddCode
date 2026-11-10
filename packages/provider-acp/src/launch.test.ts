import { describe, expect, it } from 'vitest'
import { geminiArgs, isStartupFailure, parseVersion, startupHint } from './launch.ts'

describe('ACP launch fixes', () => {
  it('reads versions out of --version output', () => {
    expect(parseVersion('gemini 0.32.1')).toEqual([0, 32, 1])
    expect(parseVersion('nothing')).toBeUndefined()
  })

  it('uses the old Gemini flag only for a CLI that predates --acp', () => {
    expect(geminiArgs(['--acp'], '0.32.9')).toEqual(['--experimental-acp'])
    expect(geminiArgs(['--acp'], '0.33.0')).toEqual(['--acp'])
    expect(geminiArgs(['--acp'], '1.2.0')).toEqual(['--acp'])
    expect(geminiArgs(['--acp'], undefined)).toEqual(['--acp'])
  })

  it('explains Gemini startup trouble, depending on whether a key is set', () => {
    expect(startupHint('/usr/bin/gemini', ['--acp'], {})).toMatch(/GEMINI_API_KEY/)
    expect(startupHint('gemini.cmd', ['--acp'], { GEMINI_API_KEY: 'x' })).not.toMatch(
      /Set GEMINI_API_KEY/,
    )
  })

  it('has hints for a few agents and none for others', () => {
    expect(startupHint('copilot', ['--acp', '--stdio'], {})).toMatch(/Upgrade/)
    expect(startupHint('cursor-agent', ['acp'], {})).toMatch(/login/)
    expect(startupHint('goose', ['acp'], {})).toBeUndefined()
  })

  it('recognises startup failure messages', () => {
    expect(isStartupFailure('initialize timed out')).toBe(true)
    expect(isStartupFailure('Gemini stopped unexpectedly')).toBe(true)
    expect(isStartupFailure('Could not apply agent setting x')).toBe(false)
  })
})

describe('Devin and tool kinds', () => {
  it('recognises a Devin ACP launch', async () => {
    const { isDevinAcp } = await import('./launch.ts')
    expect(isDevinAcp('/usr/bin/devin', ['acp'])).toBe(true)
    expect(isDevinAcp('devin.exe', ['--acp'])).toBe(true)
    expect(isDevinAcp('devin', ['login'])).toBe(false)
    expect(isDevinAcp('goose', ['acp'])).toBe(false)
  })

  it('guesses a tool kind from its title', async () => {
    const { kindFromTitle } = await import('./mapper.ts')
    expect(kindFromTitle('Read src/a.ts')).toBe('read')
    expect(kindFromTitle('bash: ls -la')).toBe('execute')
    expect(kindFromTitle('Grep foo')).toBe('search')
    expect(kindFromTitle('Rename a to b')).toBe('edit')
    expect(kindFromTitle('Frobnicate')).toBeUndefined()
    expect(kindFromTitle(undefined)).toBeUndefined()
  })
})
