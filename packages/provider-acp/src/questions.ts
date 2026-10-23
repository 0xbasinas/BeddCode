import type { ConfigOption, QuestionSpec } from '@beddcode/contracts'

type Obj = Record<string, unknown>

const obj = (v: unknown): Obj | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : undefined
const text = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined

/** A question put to the user, with how to turn their answer back into what the agent expects. */
export interface AskedQuestions<R> {
  specs: QuestionSpec[]
  /** The agent's reply to send for these answers; `undefined` answers mean the user dismissed it. */
  respond(answers?: Record<string, string[]>): R
}

// -- ACP elicitation (form mode) ---------------------------------------------------------------

export interface ElicitationReply {
  action: 'accept' | 'decline'
  content?: Record<string, string | number | boolean | string[]>
}

interface Choice {
  label: string
  value: string
  description?: string
}

/** The fixed choices of a property: an `enum`, `oneOf` titled constants, or a boolean's yes and no. */
function choicesOf(property: Obj): Choice[] {
  const fromTitled = (list: unknown): Choice[] =>
    Array.isArray(list)
      ? list.flatMap((entry) => {
          const o = obj(entry)
          const value = text(o?.const)
          return value
            ? [{ value, label: text(o?.title) ?? value, description: text(o?.description) }]
            : []
        })
      : []
  if (property.type === 'string') {
    const titled = fromTitled(property.oneOf)
    if (titled.length > 0) return titled
    return Array.isArray(property.enum)
      ? property.enum.flatMap((v) => (typeof v === 'string' ? [{ value: v, label: v }] : []))
      : []
  }
  if (property.type === 'array') {
    const items = obj(property.items)
    const titled = fromTitled(items?.anyOf)
    if (titled.length > 0) return titled
    return Array.isArray(items?.enum)
      ? items.enum.flatMap((v) => (typeof v === 'string' ? [{ value: v, label: v }] : []))
      : []
  }
  if (property.type === 'boolean') {
    return [
      { value: 'true', label: 'Yes' },
      { value: 'false', label: 'No' },
    ]
  }
  return []
}

/**
 * Turns an `elicitation/create` form (a flat object schema) into questions: each property is one
 * question, its fixed choices become options, and anything free-form allows a typed answer. Returns
 * undefined for a request that is not a form this can show.
 */
export function elicitationQuestions(
  request: unknown,
): AskedQuestions<ElicitationReply> | undefined {
  const req = obj(request)
  const schema = obj(req?.requestedSchema)
  const properties = obj(schema?.properties)
  if (!req || req.mode !== 'form' || !properties || Object.keys(properties).length === 0) {
    return undefined
  }
  const message = text(req.message)
  const required = new Set(Array.isArray(schema?.required) ? (schema.required as string[]) : [])

  const entries = Object.entries(properties).flatMap(([key, raw], index) => {
    const property = obj(raw)
    if (!property || typeof property.type !== 'string') return []
    const choices = choicesOf(property)
    const header = text(property.title) ?? key
    const detail = text(property.description)
    const spec: QuestionSpec = {
      id: key,
      header,
      // The request's own message belongs with the first question; the rest speak for themselves.
      question:
        [index === 0 ? message : undefined, detail ?? (index === 0 ? undefined : header)]
          .filter(Boolean)
          .join('\n\n') || header,
      options:
        choices.length > 0
          ? choices.map((c) => ({ label: c.label, description: c.description }))
          : undefined,
      multiSelect: property.type === 'array' ? true : undefined,
      allowOther: choices.length === 0 || undefined,
    }
    return [{ key, property, choices, spec, required: required.has(key) }]
  })
  if (entries.length === 0) return undefined

  return {
    specs: entries.map((e) => e.spec),
    respond(answers) {
      if (!answers) return { action: 'decline' }
      const content: NonNullable<ElicitationReply['content']> = {}
      for (const { key, property, choices } of entries) {
        const given = (answers[key] ?? []).map((v) => v.trim()).filter(Boolean)
        if (given.length === 0) continue
        // An answer is a choice's label (or typed text); send the value the agent defined.
        const valueOf = (answer: string) => choices.find((c) => c.label === answer)?.value ?? answer
        switch (property.type) {
          case 'boolean':
            content[key] = valueOf(given[0]!) === 'true'
            break
          case 'number':
          case 'integer': {
            const n = Number(given[0])
            if (Number.isFinite(n)) content[key] = property.type === 'integer' ? Math.trunc(n) : n
            break
          }
          case 'array':
            content[key] = given.map(valueOf)
            break
          default:
            content[key] = valueOf(given[0]!)
        }
      }
      return Object.keys(content).length === 0
        ? { action: 'decline' }
        : { action: 'accept', content }
    },
  }
}

// -- Grok's own questions and plan hand-off ----------------------------------------------------

/** Methods Grok uses; it has sent them with and without a leading underscore. */
export const GROK_QUESTION_METHODS = ['_x.ai/ask_user_question', 'x.ai/ask_user_question']
export const GROK_PLAN_METHODS = ['_x.ai/exit_plan_mode', 'x.ai/exit_plan_mode']

export type GrokQuestionReply =
  | { outcome: 'accepted'; answers: Record<string, string[]>; annotations: Record<string, never> }
  | { outcome: 'cancelled' }

/** Grok's `ask_user_question`: questions with options, answered by option labels keyed by question. */
export function grokQuestions(request: unknown): AskedQuestions<GrokQuestionReply> | undefined {
  const asked = obj(request)?.questions
  if (!Array.isArray(asked) || asked.length === 0) return undefined
  const questions = asked.flatMap((raw) => {
    const q = obj(raw)
    const question = text(q?.question)
    return q && question ? [{ q, question }] : []
  })
  if (questions.length === 0) return undefined

  return {
    specs: questions.map(({ q, question }, i) => {
      const options = Array.isArray(q.options)
        ? q.options.flatMap((o) => {
            const label = text(obj(o)?.label)
            return label ? [{ label, description: text(obj(o)?.description) }] : []
          })
        : []
      return {
        id: `q${i}`,
        header: text(q.label) ?? 'Question',
        question,
        options: options.length > 0 ? options : undefined,
        multiSelect: q.multiSelect === true || undefined,
        allowOther: options.length === 0 || undefined,
      }
    }),
    respond(answers) {
      const accepted: Record<string, string[]> = {}
      questions.forEach(({ question }, i) => {
        const given = (answers?.[`q${i}`] ?? []).map((v) => v.trim()).filter(Boolean)
        if (given.length > 0) accepted[question] = given
      })
      return Object.keys(accepted).length === 0
        ? { outcome: 'cancelled' }
        : { outcome: 'accepted', answers: accepted, annotations: {} }
    },
  }
}

/** The finished plan Grok hands over (markdown), if there is one. */
export function grokPlan(request: unknown): string | undefined {
  return text(obj(request)?.planContent)
}

export const KEEP_PLANNING_FEEDBACK =
  'The user has not approved this plan yet and wants to keep planning. Do not implement it; end this turn and wait for their next message.'

// -- Models some agents report outside the config options --------------------------------------

/**
 * Older agents list their models in a separate `models` block (set with `session/set_model`) rather
 * than as a config option. Shown as a model setting so the picker works the same either way.
 */
export function modelOptionFromState(models: unknown): ConfigOption | undefined {
  const state = obj(models)
  const available = Array.isArray(state?.availableModels) ? state.availableModels : []
  const choices = available.flatMap((m) => {
    const o = obj(m)
    const value = text(o?.modelId)
    return value ? [{ value, name: text(o?.name) ?? value, description: text(o?.description) }] : []
  })
  if (choices.length === 0) return undefined
  return {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    value: text(state?.currentModelId) ?? choices[0]!.value,
    choices,
  }
}
