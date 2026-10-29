import type { PermissionOption } from '@agentclientprotocol/sdk'
import { describe, expect, it } from 'vitest'
import { JsonRpcError } from '@beddcode/shared'
import { grokHooks, grokNotifications, XAI_RATE_LIMITED } from './hooks.ts'

const hooks = (env: NodeJS.ProcessEnv = {}, skills: string[] = ['review', 'plan']) =>
  grokHooks({ skills: async () => skills, env })

describe('grokHooks', () => {
  it('declares itself an extension and tags cancels, so Grok asks instead of refusing', () => {
    const h = hooks()
    expect(h.initializeMeta).toEqual({ clientType: 'extension' })
    expect(h.cancelMeta).toEqual({ cancelTrigger: 'ctrl_c' })
    expect(h.authMeta).toEqual({ headless: true })
  })

  it('tries only the sign-in that fits, and never the browser one', () => {
    const ids = ['cached_token', 'grok.com', 'xai.api_key']
    expect(hooks({}).authOrder!(ids)).toEqual(['cached_token'])
    expect(hooks({ XAI_API_KEY: 'k' }).authOrder!(ids)).toEqual(['xai.api_key'])
    expect(hooks({ XAI_API_KEY: ' ' }).authOrder!(ids)).toEqual(['cached_token'])
    expect(hooks({}).authOrder!(['grok.com'])).toEqual([])
  })

  it('explains a usage-limit error', () => {
    const h = hooks()
    expect(h.describeError!(new JsonRpcError(XAI_RATE_LIMITED, 'raw'))).toMatch(/usage limit/)
    expect(h.describeError!(new JsonRpcError(-32603, 'other'))).toBeUndefined()
    expect(h.describeError!(new Error('x'))).toBeUndefined()
  })

  it('turns a leading $skill into /skill only for a skill Grok has', async () => {
    const h = hooks()
    expect(await h.transformPrompt!('$review the diff')).toBe('/review the diff')
    expect(await h.transformPrompt!('  $plan')).toBe('  /plan')
    expect(await h.transformPrompt!('$unknown thing')).toBe('$unknown thing')
    expect(await h.transformPrompt!('costs $5 and $review later')).toBe(
      'costs $5 and $review later',
    )
    expect(await h.transformPrompt!('/review already')).toBe('/review already')
  })

  it('does not look up skills for text without a mention', async () => {
    let looked = false
    const h = grokHooks({
      skills: async () => {
        looked = true
        return []
      },
    })
    await h.transformPrompt!('no mention here')
    expect(looked).toBe(false)
  })

  it('offers only the "always allow" choice that stays inside the session', () => {
    const options: PermissionOption[] = [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'allow-edits-session', name: 'Allow edits', kind: 'allow_always' },
      { optionId: 'allow-command-always', name: 'Always', kind: 'allow_always' },
      { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
    ]
    expect(hooks().filterPermissionOptions!(options).map((o) => o.optionId)).toEqual([
      'allow',
      'allow-edits-session',
      'reject',
    ])
  })
})

describe('grokNotifications', () => {
  const ctx = { sessionId: 'g-1' }
  const models = {
    currentModelId: 'grok-4.7',
    availableModels: [
      { modelId: 'grok-4.7', _meta: { totalContextTokens: 256000 } },
      { modelId: 'grok-4.6', _meta: { totalContextTokens: 128000 } },
    ],
  }
  const completed = (sessionId = 'g-1') => ({
    sessionId,
    update: {
      sessionUpdate: 'response_completed',
      usage: { input_tokens: 25172, cache_read_input_tokens: 1664, cache_creation_input_tokens: 0 },
    },
  })

  it('reports how full the context window is, once it knows the model’s window', () => {
    const note = grokNotifications()
    expect(note('_x.ai/session_notification', completed(), ctx)).toBeUndefined()
    note('_x.ai/models/update', models, ctx)
    expect(note('_x.ai/session_notification', completed(), ctx)).toEqual([
      { type: 'session.context', used: 26836, size: 256000 },
    ])
  })

  it('follows a change of model, and ignores another session’s messages', () => {
    const note = grokNotifications()
    note('x.ai/models/update', models, ctx)
    note('x.ai/models/update', { ...models, currentModelId: 'grok-4.6' }, ctx)
    expect(note('x.ai/session_notification', completed(), ctx)).toEqual([
      { type: 'session.context', used: 26836, size: 128000 },
    ])
    expect(note('x.ai/session_notification', completed('other'), ctx)).toBeUndefined()
  })

  it('names the session with the title Grok gives it, once per title', () => {
    const note = grokNotifications()
    const changed = (title: string | null, sessionId = 'g-1') => ({
      upserted: [
        { sessionId: 'x', title: 'not mine' },
        { sessionId, title },
      ],
    })
    expect(note('_x.ai/sessions/changed', changed(null), ctx)).toBeUndefined()
    expect(note('_x.ai/sessions/changed', changed(' Fix the build '), ctx)).toEqual([
      { type: 'session.renamed', title: 'Fix the build' },
    ])
    expect(note('_x.ai/sessions/changed', changed('Fix the build'), ctx)).toBeUndefined()
    expect(note('_x.ai/sessions/changed', changed('Fix the tests'), ctx)).toEqual([
      { type: 'session.renamed', title: 'Fix the tests' },
    ])
    expect(note('_x.ai/sessions/changed', changed('Elsewhere', 'other'), ctx)).toBeUndefined()
  })

  it('reports compaction from start to finish, with sizes', () => {
    const note = grokNotifications()
    const update = (u: object) => ({ sessionId: 'g-1', update: u })
    expect(
      note('_x.ai/session_notification', update({ sessionUpdate: 'auto_compact_started' }), ctx),
    ).toEqual([{ type: 'session.compaction', state: 'started' }])
    expect(
      note(
        '_x.ai/session_notification',
        update({ sessionUpdate: 'auto_compact_completed', tokens_before: 90000, tokens_after: 0 }),
        ctx,
      ),
    ).toEqual([{ type: 'session.compaction', state: 'finished', tokensBefore: 90000 }])
  })

  it('ignores messages it does not know and malformed ones', () => {
    const note = grokNotifications()
    expect(note('_x.ai/queue/changed', { entries: [] }, ctx)).toBeUndefined()
    expect(note('_x.ai/sessions/changed', 'nonsense', ctx)).toBeUndefined()
    expect(note('_x.ai/session_notification', null, ctx)).toBeUndefined()
  })
})
