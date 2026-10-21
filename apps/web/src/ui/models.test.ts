import { describe, expect, it } from 'vitest'
import { modelChoice, modelEfforts } from './models.ts'

const models = [
  { id: 'deep', label: 'Deep', efforts: ['high', 'xhigh'] },
  { id: 'fast', label: 'Fast', efforts: ['low'] },
  { id: 'plain', label: 'Plain', efforts: [] },
  { id: 'legacy', label: 'Legacy' },
]

describe('model effort choices', () => {
  it('uses each model’s advertised efforts, including none, and falls back for older agents', () => {
    expect(modelEfforts(models, ['medium'], 'deep')).toEqual(['high', 'xhigh'])
    expect(modelEfforts(models, ['medium'], 'plain')).toEqual([])
    expect(modelEfforts(models, ['medium'], 'legacy')).toEqual(['medium'])
  })
  it('clears an incompatible effort when switching models and keeps a supported choice', () => {
    expect(modelChoice(models, ['medium'], { model: 'fast', effort: 'xhigh' })).toEqual({
      model: 'fast',
      effort: undefined,
    })
    expect(modelChoice(models, ['medium'], { model: 'deep', effort: 'high' })).toEqual({
      model: 'deep',
      effort: 'high',
    })
  })
  it('leaves the default effort unset and rejects removed model ids', () => {
    expect(modelChoice(models, ['medium'], {})).toEqual({ model: undefined, effort: undefined })
    expect(modelChoice(models, ['medium'], { model: 'removed', effort: 'high' })).toEqual({
      model: undefined,
      effort: undefined,
    })
  })
})
