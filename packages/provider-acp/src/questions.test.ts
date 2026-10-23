import { describe, expect, it } from 'vitest'
import { elicitationQuestions, grokPlan, grokQuestions, modelOptionFromState } from './questions.ts'

describe('elicitationQuestions', () => {
  const form = {
    mode: 'form',
    message: 'Which environment should I deploy to?',
    requestedSchema: {
      type: 'object',
      required: ['env'],
      properties: {
        env: {
          type: 'string',
          title: 'Environment',
          oneOf: [
            { const: 'stg', title: 'Staging' },
            { const: 'prod', title: 'Production', description: 'Customer facing' },
          ],
        },
        notes: { type: 'string', title: 'Notes', description: 'Anything to add?' },
        replicas: { type: 'integer', title: 'Replicas' },
        dryRun: { type: 'boolean', title: 'Dry run' },
        regions: { type: 'array', title: 'Regions', items: { enum: ['eu', 'us'] } },
      },
    },
  }

  it('turns each property into a question, with its choices as options', () => {
    const asked = elicitationQuestions(form)!
    expect(asked.specs.map((s) => s.id)).toEqual(['env', 'notes', 'replicas', 'dryRun', 'regions'])
    expect(asked.specs[0]).toMatchObject({
      header: 'Environment',
      question: 'Which environment should I deploy to?',
      options: [{ label: 'Staging' }, { label: 'Production', description: 'Customer facing' }],
    })
    expect(asked.specs[1]).toMatchObject({ question: 'Anything to add?', allowOther: true })
    expect(asked.specs[3]?.options?.map((o) => o.label)).toEqual(['Yes', 'No'])
    expect(asked.specs[4]).toMatchObject({ multiSelect: true })
  })

  it('answers with the values the agent defined, in the types it asked for', () => {
    const reply = elicitationQuestions(form)!.respond({
      env: ['Production'],
      notes: ['  careful '],
      replicas: ['3.9'],
      dryRun: ['Yes'],
      regions: ['eu', 'us'],
    })
    expect(reply).toEqual({
      action: 'accept',
      content: { env: 'prod', notes: 'careful', replicas: 3, dryRun: true, regions: ['eu', 'us'] },
    })
  })

  it('leaves out an answer that is not a number, and declines when there is no answer at all', () => {
    const asked = elicitationQuestions(form)!
    expect(asked.respond({ replicas: ['many'], env: ['Staging'] })).toEqual({
      action: 'accept',
      content: { env: 'stg' },
    })
    expect(asked.respond({})).toEqual({ action: 'decline' })
    expect(asked.respond(undefined)).toEqual({ action: 'decline' })
  })

  it('is not a form it can show: other modes, no properties, nothing', () => {
    expect(elicitationQuestions({ mode: 'url', message: 'x', url: 'https://x' })).toBeUndefined()
    expect(
      elicitationQuestions({ mode: 'form', message: 'x', requestedSchema: { properties: {} } }),
    ).toBeUndefined()
    expect(elicitationQuestions(null)).toBeUndefined()
  })
})

describe('grokQuestions', () => {
  const request = {
    sessionId: 's',
    toolCallId: 't',
    questions: [
      {
        question: 'Which database?',
        label: 'Database',
        options: [{ label: 'Postgres', description: 'Relational' }, { label: 'SQLite' }],
      },
      { question: 'Features?', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] },
    ],
  }

  it('asks each question with its options', () => {
    const asked = grokQuestions(request)!
    expect(asked.specs).toMatchObject([
      {
        id: 'q0',
        header: 'Database',
        question: 'Which database?',
        options: [{ label: 'Postgres' }, { label: 'SQLite' }],
      },
      { id: 'q1', header: 'Question', multiSelect: true },
    ])
  })

  it('answers by question text, or cancels when nothing was answered', () => {
    const asked = grokQuestions(request)!
    expect(asked.respond({ q0: ['SQLite'], q1: ['A', 'B'] })).toEqual({
      outcome: 'accepted',
      answers: { 'Which database?': ['SQLite'], 'Features?': ['A', 'B'] },
      annotations: {},
    })
    expect(asked.respond(undefined)).toEqual({ outcome: 'cancelled' })
  })

  it('ignores a request with no questions', () => {
    expect(grokQuestions({ questions: [] })).toBeUndefined()
    expect(grokQuestions({})).toBeUndefined()
  })
})

describe('grokPlan', () => {
  it('returns the plan text, trimmed, or nothing', () => {
    expect(grokPlan({ planContent: '  # Plan\n- a\n' })).toBe('# Plan\n- a')
    expect(grokPlan({ planContent: '  ' })).toBeUndefined()
    expect(grokPlan({ planContent: null })).toBeUndefined()
  })
})

describe('modelOptionFromState', () => {
  it('shows a models block as a model setting', () => {
    expect(
      modelOptionFromState({
        currentModelId: 'm2',
        availableModels: [
          { modelId: 'm1', name: 'Model 1' },
          { modelId: 'm2', name: 'Model 2', description: 'Bigger' },
        ],
      }),
    ).toEqual({
      id: 'model',
      name: 'Model',
      category: 'model',
      type: 'select',
      value: 'm2',
      choices: [
        { value: 'm1', name: 'Model 1', description: undefined },
        { value: 'm2', name: 'Model 2', description: 'Bigger' },
      ],
    })
  })

  it('has nothing to show for no models', () => {
    expect(modelOptionFromState(undefined)).toBeUndefined()
    expect(modelOptionFromState({ availableModels: [] })).toBeUndefined()
  })
})
