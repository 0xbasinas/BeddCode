import { describe, expect, it } from 'vitest'
import type { ProviderInstance } from '@beddcode/contracts'
import { resolveRun } from './resolve.ts'

const caps = (over: object) =>
  ({
    resume: true,
    fork: false,
    steer: false,
    planMode: true,
    imageInput: true,
    usage: true,
    ...over,
  }) as never

const claude = {
  id: 'claude-1',
  kind: 'claude',
  label: 'Claude Code',
  status: 'ready',
  capabilities: caps({
    permissionModes: [
      { id: 'default', label: 'Ask before edits' },
      { id: 'acceptEdits', label: 'Auto-accept edits' },
      { id: 'plan', label: 'Plan mode' },
      { id: 'bypassPermissions', label: 'Full access', dangerous: true },
    ],
    models: [
      {
        id: 'sonnet',
        label: 'Sonnet',
        description: 'Balanced speed and quality',
        efforts: ['low', 'medium', 'high'],
      },
      {
        id: 'opus',
        label: 'Opus',
        description: 'Deep reasoning for complex changes',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      },
      { id: 'haiku', label: 'Haiku', description: 'Fast and light, for small edits' },
    ],
  }),
} as ProviderInstance

const codex = {
  id: 'codex-1',
  kind: 'codex',
  label: 'Codex',
  status: 'ready',
  capabilities: caps({
    permissionModes: [
      { id: 'read-only', label: 'Read only' },
      { id: 'full-access', label: 'Full access', dangerous: true },
    ],
    models: [
      { id: 'gpt-5', label: 'GPT-5', efforts: ['minimal', 'low', 'medium', 'high'] },
      { id: 'gpt-5-mini', label: 'GPT-5 mini', efforts: ['low', 'medium'] },
    ],
  }),
} as ProviderInstance

const all = [claude, codex]

describe('resolveRun', () => {
  it('reads "use sonnet 5.5 on medium" against the real model list', () => {
    const r = resolveRun(
      all,
      {},
      'please make the composer less tall slightly, use sonnet 5.5 on medium',
    )
    expect(r).toMatchObject({ model: 'sonnet', effort: 'medium' })
    expect(r.instance?.id).toBe('claude-1')
  })
  it('picks the agent from a choice, not from a topic', () => {
    expect(resolveRun(all, {}, 'fix this with codex').instance?.id).toBe('codex-1')
    expect(resolveRun(all, {}, 'fix the codex bug in the settings page').instance?.id).toBe(
      'claude-1',
    )
  })
  it('takes explicit settings over the text, and matches labels and versions', () => {
    expect(
      resolveRun(all, { agent: 'codex', model: 'GPT-5 mini', effort: 'high' }, ''),
    ).toMatchObject({
      model: 'gpt-5-mini',
      // gpt-5-mini has no "high", so the nearest it has.
      effort: 'medium',
    })
    expect(resolveRun(all, { model: 'opus 4.1' }, '').model).toBe('opus')
  })
  it('understands tiers like fast and best, but only when asked for as a model', () => {
    expect(resolveRun(all, {}, 'please do this with the fastest model').model).toBe('haiku')
    expect(resolveRun(all, {}, 'use the best model here').model).toBe('opus')
    expect(resolveRun(all, {}, 'make the page load fast').model).toBeUndefined()
  })
  it('maps words to the efforts a model has, and "full" to the dangerous mode', () => {
    expect(resolveRun(all, { permissionMode: 'full' }, '').permissionMode).toBe('bypassPermissions')
    expect(
      resolveRun(all, { agent: 'codex', permissionMode: 'full access' }, '').permissionMode,
    ).toBe('full-access')
    expect(resolveRun(all, { permissionMode: 'plan' }, '').permissionMode).toBe('plan')
    expect(resolveRun(all, { model: 'opus' }, 'on max effort').effort).toBe('max')
    expect(resolveRun(all, { model: 'sonnet' }, 'use sonnet, think hard').effort).toBe('high')
  })
  it('says what it could not match instead of failing', () => {
    const r = resolveRun(all, { model: 'gemini-9', permissionMode: 'turbo' }, '')
    expect(r.model).toBeUndefined()
    expect(r.notes.join(' ')).toContain('gemini-9')
    expect(r.notes.join(' ')).toContain('sonnet')
    expect(r.notes.join(' ')).toContain('turbo')
  })
  it('skips agents that are not ready', () => {
    const down = { ...claude, status: 'needs-sign-in' } as ProviderInstance
    expect(resolveRun([down, codex], {}, '').instance?.id).toBe('codex-1')
    expect(resolveRun([down], {}, '').instance).toBeUndefined()
  })
})
