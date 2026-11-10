import type { ModelOption, ProviderInstance } from '@beddcode/contracts'
import type { RunSettings } from './config.ts'

/** What a request resolves to on this host, plus what could not be matched (said in the reply). */
export interface Resolved {
  instance?: ProviderInstance
  model?: string
  effort?: string
  permissionMode?: string
  notes: string[]
}

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim()
const words = (text: string) => norm(text).split(' ').filter(Boolean)
const has = (haystack: string, needle: string) =>
  needle.length > 0 && new RegExp(`(^| )${needle.replace(/[.]/g, '\\.')}( |$)`).test(haystack)

/**
 * What was asked for by choice rather than by topic: "use sonnet on medium" counts, "fix the codex
 * bug" does not. Only text right after a word like with, using, use, on or via is looked at.
 */
export function chosen(text: string): string[] {
  return [
    ...norm(text).matchAll(
      /(?:^| )(?:with|using|use|via|by|on|model|agent)(?: the)? ([a-z0-9. ]{2,40})/g,
    ),
  ].map((m) => m[1]!)
}

const ready = (p: ProviderInstance) => p.status === undefined || p.status === 'ready'

/** Picks the agent: the one asked for by name, else one named in the text, else the first that is ready. */
export function pickAgent(
  providers: ProviderInstance[],
  asked: string | undefined,
  text: string,
): ProviderInstance | undefined {
  const usable = providers.filter(ready)
  const names = (p: ProviderInstance) =>
    [p.id, p.kind, ...words(p.label).slice(0, 1)].filter(Boolean).map((n) => norm(String(n)))
  const find = (query: string) => {
    const q = norm(query)
    return (
      usable.find((p) => names(p).includes(q)) ??
      usable.find((p) => norm(p.label).startsWith(q)) ??
      usable.find((p) => norm(p.label).includes(q))
    )
  }
  if (asked) return find(asked)
  for (const phrase of chosen(text)) {
    const hit = usable.find((p) => names(p).some((n) => n.length > 2 && has(phrase, n)))
    if (hit) return hit
  }
  return usable[0]
}

const SMALL = /(haiku|mini|flash|lite|light|small|fast|nano|spark)/
const BIG = /(opus|pro\b|max|large|ultra|heavy|high)/
const TIERS: [RegExp, (m: ModelOption) => boolean][] = [
  [
    /\b(fast|fastest|quick|quickest|cheap|cheapest|light|lightweight|small|smallest)\b/,
    (m) => SMALL.test(norm(`${m.id} ${m.label}`)),
  ],
  [
    /\b(best|smartest|strongest|most capable|biggest|deepest|powerful)\b/,
    (m) => BIG.test(norm(`${m.id} ${m.label}`)),
  ],
  [
    /\b(balanced|default|standard)\b/,
    (m) => /(sonnet|balanced|standard)/.test(norm(`${m.id} ${m.label} ${m.description ?? ''}`)),
  ],
]

/** Finds a model by what was written: its id, its label, the family word of either, or a tier like "fast". */
export function pickModel(
  models: ModelOption[],
  asked: string | undefined,
  text: string,
): ModelOption | undefined {
  if (models.length === 0) return undefined
  const query = norm(asked ?? '')
  const scan = (needle: string, loose: boolean) => {
    let best: { model: ModelOption; score: number } | undefined
    for (const model of models) {
      const labels = [model.id, model.label].map(norm)
      // Versions are ignored for the family match: "sonnet 5.5" finds the model called sonnet.
      const family = labels.flatMap((l) =>
        l.split(' ').filter((w) => /[a-z]/.test(w) && w.length > 2),
      )
      const score = labels.includes(needle)
        ? 1000
        : labels.some((l) => l.length > 2 && has(needle, l))
          ? 500 + Math.max(...labels.map((l) => l.length))
          : loose && family.some((w) => has(needle, w))
            ? 100 + Math.max(...family.filter((w) => has(needle, w)).map((w) => w.length))
            : 0
      if (score > 0 && (!best || score > best.score)) best = { model, score }
    }
    return best?.model
  }
  if (query) {
    const exact = models.find((m) => m.id === asked) ?? scan(query, true)
    if (exact) return exact
    for (const [pattern, test] of TIERS) if (pattern.test(query)) return models.find(test)
    return undefined
  }
  for (const phrase of chosen(text)) {
    const named = scan(phrase, false) ?? scan(phrase, true)
    if (named) return named
    for (const [pattern, test] of TIERS) if (pattern.test(phrase)) return models.find(test)
  }
  return undefined
}

const EFFORT_WORDS: Record<string, string[]> = {
  low: ['low', 'minimal', 'quick', 'light', 'little'],
  medium: ['medium', 'normal', 'balanced', 'moderate'],
  high: ['high', 'deep', 'thorough', 'hard', 'careful'],
  xhigh: ['xhigh', 'extra high', 'very high'],
  max: ['max', 'maximum', 'ultra', 'everything'],
}
const ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** Maps what was written ("low", "think hard", "max") onto the efforts this model really offers. */
export function pickEffort(
  available: string[],
  asked: string | undefined,
  text: string,
): string | undefined {
  if (available.length === 0) return undefined
  const exact = (word: string) => available.find((e) => norm(e) === norm(word))
  if (asked) {
    const direct = exact(asked)
    if (direct) return direct
  }
  let level = asked
    ? Object.keys(EFFORT_WORDS).find((k) => EFFORT_WORDS[k]!.includes(norm(asked)))
    : undefined
  if (!level) {
    const spoken = norm(text)
    const hit =
      /\b(?:effort|reasoning|thinking)\s+(\w+)/.exec(spoken)?.[1] ??
      /\b(\w+)\s+(?:effort|reasoning)/.exec(spoken)?.[1] ??
      /\bon\s+(\w+)/.exec(spoken)?.[1] ??
      (/think(?:ing)? (?:really )?hard/.test(spoken) ? 'high' : undefined)
    if (hit) level = Object.keys(EFFORT_WORDS).find((k) => EFFORT_WORDS[k]!.includes(hit))
  }
  if (!level) return undefined
  const direct = exact(level)
  if (direct) return direct
  // The model has no level of that name: take the nearest one it does have.
  const rank = (e: string) => ORDER.indexOf(norm(e).replace(' ', ''))
  const want = ORDER.indexOf(level)
  const known = available.filter((e) => rank(e) >= 0)
  return known.sort((a, b) => Math.abs(rank(a) - want) - Math.abs(rank(b) - want))[0]
}

const FULL = /^(full|full access|bypass|bypasspermissions|yolo|no prompts|auto|dangerous)$/
const ASK = /^(ask|default|ask before edits|prompt|normal)$/
const PLAN = /^(plan|read only|readonly|read-only)$/

/** Finds a permission mode by its id or label, or by what it means: "full" is the one marked dangerous. */
export function pickMode(
  instance: ProviderInstance,
  asked: string | undefined,
): string | undefined {
  const modes = instance.capabilities?.permissionModes ?? []
  if (!asked) return undefined
  const q = norm(asked)
  const direct = modes.find((m) => norm(m.id) === q || norm(m.label) === q)
  if (direct) return direct.id
  if (FULL.test(q)) return modes.find((m) => m.dangerous)?.id
  if (PLAN.test(q)) return modes.find((m) => /plan|read/.test(norm(`${m.id} ${m.label}`)))?.id
  if (ASK.test(q)) return modes.find((m) => /(default|ask)/.test(norm(`${m.id} ${m.label}`)))?.id
  return undefined
}

/**
 * Turns what the config and the comment asked for into what this host can actually run. The
 * host's own list of agents, models, efforts and modes decides, so a name that does not exist
 * is reported instead of failing the job.
 */
export function resolveRun(
  providers: ProviderInstance[],
  want: RunSettings,
  text: string,
): Resolved {
  const notes: string[] = []
  const instance = pickAgent(providers, want.agent, text)
  if (!instance) return { notes }
  const caps = instance.capabilities
  const models = caps?.models ?? []
  const model = pickModel(models, want.model, text)
  if (want.model && !model)
    notes.push(
      models.length === 0
        ? `${instance.label} chooses its own model, so \`${want.model}\` was ignored.`
        : `I do not have a model matching \`${want.model}\` on ${instance.label}; I used its default. It offers: ${models.map((m) => m.id).join(', ')}.`,
    )
  const efforts = model?.efforts?.length ? model.efforts : (caps?.efforts ?? [])
  const effort = pickEffort(efforts, want.effort, text)
  if (want.effort && !effort)
    notes.push(
      `${model?.label ?? instance.label} has no effort setting called \`${want.effort}\`; I used its default.`,
    )
  const permissionMode = pickMode(instance, want.permissionMode)
  if (want.permissionMode && !permissionMode)
    notes.push(
      `There is no permission mode like \`${want.permissionMode}\` on ${instance.label}; I used its default.`,
    )
  return { instance, model: model?.id, effort, permissionMode, notes }
}
