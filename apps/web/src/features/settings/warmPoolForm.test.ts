import { describe, expect, it } from 'vitest'
import { WARM_POOL_DEFAULTS } from '@beddcode/contracts'
import { changeFromDraft, draftFromSettings } from './warmPoolForm.ts'

describe('warm pool form', () => {
  it('sends only what changed', () => {
    const draft = { ...draftFromSettings(WARM_POOL_DEFAULTS), size: '3' }
    expect(changeFromDraft(draft, WARM_POOL_DEFAULTS)).toEqual({ change: { size: 3 } })
    expect(changeFromDraft(draftFromSettings(WARM_POOL_DEFAULTS), WARM_POOL_DEFAULTS)).toEqual({
      change: {},
    })
  })
  it.each([['5'], ['-1'], ['1.5'], [''], ['abc']])('rejects a pool size of %j', (size) => {
    const draft = { ...draftFromSettings(WARM_POOL_DEFAULTS), size }
    expect(changeFromDraft(draft, WARM_POOL_DEFAULTS)).toEqual({
      error: 'Pool size must be a whole number from 0 to 4.',
    })
  })
})
