import { describe, expect, it } from 'vitest'
import { KNOWN_AGENTS, detectKnownAgents } from './known.ts'

describe('known ACP agents', () => {
  it('has unique ids and no native-adapter agents', () => {
    const ids = KNOWN_AGENTS.map((a) => a.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const native of ['claude', 'codex', 'grok-build', 'pi', 'opencode'])
      expect(ids).not.toContain(native)
  })

  it('marks an agent installed only when its command and requirements resolve', () => {
    const found = new Set(['gemini', 'ante'])
    const result = detectKnownAgents((c) => (found.has(c) ? `/bin/${c}` : null), 'linux')
    const by = Object.fromEntries(result.map((a) => [a.id, a]))
    expect(by.gemini).toMatchObject({ installed: true, missing: [] })
    expect(by.ante).toMatchObject({ installed: false, missing: ['ante-acp'] })
    expect(by.goose?.missing).toEqual(['goose'])
  })

  it('hides platform-specific agents elsewhere', () => {
    const ids = (p: NodeJS.Platform) => detectKnownAgents(() => null, p).map((a) => a.id)
    expect(ids('win32')).toContain('antigravity')
    expect(ids('linux')).not.toContain('antigravity')
  })
})
