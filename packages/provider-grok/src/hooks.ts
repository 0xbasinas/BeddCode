import type { PermissionOption } from '@agentclientprotocol/sdk'
import type { AcpDraft, AcpHooks } from '@beddcode/provider-acp'
import { JsonRpcError } from '@beddcode/shared'

/** Grok reports an exhausted plan or rate limit with this error code. */
export const XAI_RATE_LIMITED = -32003

/** The one "always allow" choice that stays inside the session instead of becoming a saved rule. */
const SESSION_EDITS_OPTION = 'allow-edits-session'

export interface GrokHookOptions {
  /** Names of the skills Grok has enabled for the folder; looked up only when a prompt needs them. */
  skills(): Promise<string[]>
  env?: NodeJS.ProcessEnv
}

/**
 * Grok's own needs beyond the protocol, found in its documentation and in how other clients drive it:
 *
 * - `clientType: "extension"` makes it ask for permission instead of quietly refusing in auto mode.
 * - A cancel tagged `ctrl_c` stops it from waking background work until the next real message.
 * - It signs in with a stored token or an API key, and offers a browser sign-in this app cannot
 *   complete, so only the first two are ever tried.
 * - A leading `$skill` is the picker's spelling of Grok's `/skill`.
 */
export function grokHooks(options: GrokHookOptions): AcpHooks {
  const env = options.env ?? process.env
  const notes = grokNotifications()
  return {
    onNotification: notes,
    initializeMeta: { clientType: 'extension' },
    cancelMeta: { cancelTrigger: 'ctrl_c' },
    authMeta: { headless: true },
    authOrder: (ids) => {
      const wanted = env.XAI_API_KEY?.trim() ? 'xai.api_key' : 'cached_token'
      return ids.includes(wanted) ? [wanted] : []
    },
    describeError: (err) =>
      err instanceof JsonRpcError && err.code === XAI_RATE_LIMITED
        ? 'Grok has reached its usage limit. Wait for it to reset, or check your plan at grok.com.'
        : undefined,
    transformPrompt: async (text) => {
      const mention = /^\s*\$([A-Za-z0-9][\w:-]*)(?=\s|$)/.exec(text)
      if (!mention) return text
      const skills = await options.skills()
      if (!skills.includes(mention[1]!)) return text
      return text.replace(/^(\s*)\$/, '$1/')
    },
    filterPermissionOptions: (offered) => offered.filter(allowedChoice),
  }
}

/** Every choice except the "always allow" ones that would be saved beyond this session. */
function allowedChoice(option: PermissionOption): boolean {
  return option.kind !== 'allow_always' || option.optionId === SESSION_EDITS_OPTION
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined
const count = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0)

/**
 * What Grok says about itself outside the protocol's own updates, as events:
 *
 * - `sessions/changed` carries the title it gave the conversation.
 * - `models/update` lists each model's context window, and `response_completed` how much of it the
 *   last model call filled, which is what the context meter shows.
 *
 * Each of Grok's messages comes with and without a leading underscore. One of these is made per
 * session: it remembers the title and window sizes it has been told.
 */
export function grokNotifications(): NonNullable<AcpHooks['onNotification']> {
  const windows = new Map<string, number>()
  let model: string | undefined
  let title: string | undefined
  return (method, params, ctx) => {
    const name = method.replace(/^_/, '')
    const p = obj(params)
    const out: AcpDraft[] = []

    if (name === 'x.ai/models/update') {
      if (typeof p?.currentModelId === 'string') model = p.currentModelId
      const available = Array.isArray(p?.availableModels) ? p.availableModels : []
      for (const m of available) {
        const entry = obj(m)
        const size = count(obj(entry?._meta)?.totalContextTokens)
        if (typeof entry?.modelId === 'string' && size > 0) windows.set(entry.modelId, size)
      }
    }

    if (name === 'x.ai/sessions/changed') {
      const rows = Array.isArray(p?.upserted) ? p.upserted : []
      const mine = rows.map(obj).find((row) => row?.sessionId === ctx.sessionId)
      const next = typeof mine?.title === 'string' ? mine.title.trim() : ''
      if (next && next !== title) {
        title = next
        out.push({ type: 'session.renamed', title: next.slice(0, 120) })
      }
    }

    if (name === 'x.ai/session_notification' && p?.sessionId === ctx.sessionId) {
      const update = obj(p.update)
      const compaction = grokCompaction(update)
      if (compaction) out.push(compaction)
      const usage = obj(update?.usage)
      const size = model ? windows.get(model) : undefined
      if (update?.sessionUpdate === 'response_completed' && usage && size) {
        // What the last call read, cached or not, is the conversation as the model saw it.
        const used =
          count(usage.input_tokens) +
          count(usage.cache_read_input_tokens) +
          count(usage.cache_creation_input_tokens)
        if (used > 0) out.push({ type: 'session.context', used: Math.round(used), size })
      }
    }
    return out.length > 0 ? out : undefined
  }
}

/** Grok's own compaction of the conversation, announced by `auto_compact_*` (also for `/compact`). */
export function grokCompaction(update: Record<string, unknown> | undefined): AcpDraft | undefined {
  const kind = update?.sessionUpdate ?? update?.type
  if (kind === 'auto_compact_started') return { type: 'session.compaction', state: 'started' }
  if (kind === 'auto_compact_completed' || kind === 'auto_compact_failed') {
    const before = count(update?.tokens_before)
    const after = count(update?.tokens_after)
    return kind === 'auto_compact_failed'
      ? { type: 'session.compaction', state: 'failed' }
      : {
          type: 'session.compaction',
          state: 'finished',
          ...(before > 0 ? { tokensBefore: Math.round(before) } : {}),
          ...(after > 0 ? { tokensAfter: Math.round(after) } : {}),
        }
  }
  return undefined
}
