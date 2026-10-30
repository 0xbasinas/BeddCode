import { randomInt } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '@beddcode/shared'
import type { Logger } from '@beddcode/shared'
import type { ProviderInstance, StoredEvent } from '@beddcode/contracts'
import { digest, type SessionDigest } from '../automation/digest.ts'

const API = 'https://api.telegram.org'
const POLL_SECONDS = 30
const RETRY_MS = 5_000
const MAX_TEXT = 3_500
const PAIR_TTL_MS = 10 * 60_000
const PAIR_ATTEMPTS = 5
const REMEMBERED = 500
/** Telegram deletes up to this many messages in one request. */
const DELETE_BATCH = 100
/**
 * How many message ids back from the newest /clear tries. Ids in a private chat count up by one for
 * every message from either side, and ids that no longer exist are skipped, so a sweep also gets
 * what the bot never saw (before a restart, or typed in another app).
 */
const SWEEP_IDS = 2_000
const LIST_LENGTH = 8

type Fetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

/** What the bridge needs from the host; the real one is wired in `createAutomation`. */
export interface TelegramHost {
  create(params: {
    instanceId: string
    cwd: string
    title?: string
    model?: string
    effort?: string
    permissionMode?: string
  }): Promise<{ sessionId: string }>
  prompt(sessionId: string, text: string): Promise<unknown>
  interrupt(sessionId: string): Promise<void>
  approve(sessionId: string, requestId: string, optionId: string): Promise<void>
  answer(sessionId: string, requestId: string, answers: Record<string, string[]>): Promise<void>
  readSession(sessionId: string): StoredEvent[]
  /** Newest first. */
  recentSessionIds(limit: number): string[]
  projectPaths(): Promise<string[]>
  providers(): Promise<ProviderInstance[]>
  /** Names this host on the setup card. */
  hostLabel: string
  subscribe(listener: (stored: StoredEvent) => void): () => void
}

export interface TelegramOptions {
  file: string
  log: Logger
  host: TelegramHost
  /** Bot token from the environment; the saved one wins when both exist. */
  envToken?: string
  fetch?: Fetch
  now?: () => number
}

/** What a new session will use; `cwd` is the project. Unset fields mean the agent's own default. */
interface Draft {
  cwd: string
  instanceId?: string
  model?: string
  effort?: string
  permissionMode?: string
}

interface Saved {
  token?: string
  chats: number[]
  /** The agent, model, effort and mode of the last session started, offered again next time. */
  defaults?: Omit<Draft, 'cwd'>
}

type Field = 'project' | 'agent' | 'model' | 'effort' | 'mode'
const FIELD_LABEL: Record<Field, string> = {
  project: 'Project',
  agent: 'Agent',
  model: 'Model',
  effort: 'Effort',
  mode: 'Permissions',
}

export interface TelegramStatus {
  connected: boolean
  botName?: string
  chats: number
  pairCode?: string
}

interface Update {
  update_id: number
  message?: {
    message_id: number
    text?: string
    chat: { id: number; type: string }
    reply_to_message?: { message_id: number }
  }
  callback_query?: {
    id: string
    data?: string
    message?: { message_id: number; chat: { id: number; type: string } }
  }
}

type Button = { text: string; callback_data: string }
type Pending =
  | { kind: 'approval'; sessionId: string; requestId: string; optionId: string }
  | { kind: 'answer'; sessionId: string; requestId: string; questionId: string; label: string }
  | { kind: 'project'; cwd: string }
  | { kind: 'menu'; field: Field }
  | { kind: 'choose'; field: Field; value?: string }
  | { kind: 'card' }
  | { kind: 'session'; sessionId: string }

/** The menu Telegram shows when the user types "/". */
const MENU = [
  { command: 'new', description: 'Start an agent on a project' },
  { command: 'projects', description: 'Pick a project to work on' },
  { command: 'sessions', description: 'Recent sessions to talk to' },
  { command: 'stop', description: 'Interrupt the current session' },
  { command: 'help', description: 'What this bot can do' },
  { command: 'clear', description: 'Clean up this chat and start fresh' },
  { command: 'unpair', description: 'Remove this chat' },
]

const clip = (text: string, max = MAX_TEXT) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

/**
 * Lets the user message agents from Telegram: start sessions, send prompts, answer approvals and
 * questions, and hear when a turn ends. It polls Telegram from the host (no public address
 * needed) and answers only chats that proved they hold the pairing code shown on the host.
 */
export class TelegramBridge {
  private saved: Saved = { chats: [] }
  private botName: string | undefined
  private pairCode: { code: string; expires: number; failures: number } | undefined
  private abort: AbortController | undefined
  private unsubscribe: (() => void) | undefined
  private offset = 0
  private generation = 0
  /** Per chat: the session plain text goes to. */
  private readonly active = new Map<number, string>()
  /** Sessions whose turns, approvals and questions are sent to the chats. */
  private readonly watched = new Set<string>()
  /** Telegram message id -> session, so replying to a message prompts that session. */
  private readonly messages = new Map<number, string>()
  private readonly buttons = new Map<string, Pending>()
  private readonly questions = new Map<number, Extract<Pending, { kind: 'answer' }>>()
  /** Per chat: the project the next plain message is the task for. */
  private readonly drafts = new Map<number, Draft>()
  /** Per chat: the newest message id seen, where /clear starts sweeping. */
  private readonly newest = new Map<number, number>()
  /** Messages with an approval or question still open: message id -> the button ids they hold. */
  private readonly waiting = new Map<number, string[]>()
  private nextButton = 0
  private readonly fetch: Fetch
  private readonly now: () => number

  constructor(private readonly options: TelegramOptions) {
    this.fetch = options.fetch ?? (globalThis.fetch as unknown as Fetch)
    this.now = options.now ?? Date.now
    try {
      const raw = JSON.parse(readFileSync(options.file, 'utf8')) as Partial<Saved>
      this.saved = {
        token: typeof raw.token === 'string' && raw.token ? raw.token : undefined,
        chats: (raw.chats ?? []).filter((c): c is number => Number.isInteger(c)),
        defaults: raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : undefined,
      }
    } catch {
      // Not set up yet.
    }
  }

  private get token(): string | undefined {
    return this.saved.token ?? (this.options.envToken?.trim() || undefined)
  }

  private save() {
    writeFileAtomic(this.options.file, JSON.stringify({ version: 1, ...this.saved }, null, 2), {
      mode: 0o600,
    })
  }

  status(): TelegramStatus {
    return {
      connected: !!this.abort && !!this.botName,
      botName: this.botName,
      chats: this.saved.chats.length,
      pairCode: this.currentPairCode(),
    }
  }

  /** A fresh one-time code the user sends to the bot as `/pair <code>`. */
  newPairCode(): string {
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    this.pairCode = { code, expires: this.now() + PAIR_TTL_MS, failures: 0 }
    return code
  }

  private currentPairCode(): string | undefined {
    return this.pairCode && this.pairCode.expires > this.now() ? this.pairCode.code : undefined
  }

  /** Sets (or with null removes) the bot token and restarts polling. */
  async setToken(token: string | null): Promise<TelegramStatus> {
    this.saved.token = token?.trim() || undefined
    this.save()
    this.stop()
    this.botName = undefined
    this.start()
    return this.status()
  }

  unpairAll() {
    this.saved.chats = []
    this.active.clear()
    this.save()
  }

  start() {
    const token = this.token
    if (!token || this.abort) return
    const abort = (this.abort = new AbortController())
    const generation = ++this.generation
    if (this.saved.chats.length === 0 && !this.currentPairCode()) this.newPairCode()
    this.unsubscribe = this.options.host.subscribe((stored) => void this.onEvent(stored))
    void this.run(token, abort.signal, generation)
  }

  stop() {
    this.abort?.abort()
    this.abort = undefined
    this.unsubscribe?.()
    this.unsubscribe = undefined
  }

  private async call<T>(
    token: string,
    method: string,
    body: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await this.fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
    const json = (await res.json()) as { ok?: boolean; result?: T; description?: string }
    if (!res.ok || !json.ok) throw new Error(json.description ?? `Telegram answered ${res.status}`)
    return json.result as T
  }

  private async run(token: string, signal: AbortSignal, generation: number) {
    const { log } = this.options
    while (!signal.aborted && generation === this.generation) {
      try {
        if (!this.botName) {
          const me = await this.call<{ username?: string }>(token, 'getMe', {}, signal)
          this.botName = me.username
          // The "/" menu; a failure only means the user types the commands by hand.
          await this.call(token, 'setMyCommands', { commands: MENU }, signal).catch(() => {})
          const code = this.currentPairCode()
          log.info(
            `Telegram bot @${me.username} is on` +
              (code ? `; send it "/pair ${code}" to connect your chat` : ''),
          )
        }
        const updates = await this.call<Update[]>(
          token,
          'getUpdates',
          {
            offset: this.offset,
            timeout: POLL_SECONDS,
            allowed_updates: ['message', 'callback_query'],
          },
          signal,
        )
        for (const update of updates) {
          this.offset = update.update_id + 1
          await this.handle(token, update).catch((err: unknown) =>
            log.warn('could not handle a Telegram message', err),
          )
        }
      } catch (err) {
        if (signal.aborted) return
        log.warn('Telegram polling failed; trying again soon', err)
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
      }
    }
  }

  private async send(chat: number, text: string, buttons?: Button[][], sessionId?: string) {
    const token = this.token
    if (!token) return undefined
    try {
      const sent = await this.call<{ message_id: number }>(token, 'sendMessage', {
        chat_id: chat,
        text: clip(text),
        ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
      })
      if (sessionId) this.remember(this.messages, sent.message_id, sessionId)
      const open = (buttons ?? [])
        .flat()
        .map((b) => b.callback_data)
        .filter((id) => {
          const kind = this.buttons.get(id)?.kind
          return kind === 'approval' || kind === 'answer'
        })
      if (open.length) this.remember(this.waiting, sent.message_id, open)
      this.track(chat, sent.message_id)
      return sent.message_id
    } catch (err) {
      this.options.log.warn('could not send a Telegram message', err)
      return undefined
    }
  }

  private track(chat: number, messageId: number) {
    this.newest.set(chat, Math.max(this.newest.get(chat) ?? 0, messageId))
  }

  /** An approval or question message that still waits for its answer must outlive /clear. */
  private isWaiting(messageId: number): boolean {
    if (this.questions.has(messageId)) return true
    return this.waiting.get(messageId)?.some((id) => this.buttons.has(id)) ?? false
  }

  /** Deletes what the bot and the user wrote here, and forgets the chat's setup and session. */
  private async clear(chat: number) {
    const token = this.token
    const newest = this.newest.get(chat) ?? 0
    this.drafts.delete(chat)
    this.active.delete(chat)
    for (let top = newest; top > 0 && top > newest - SWEEP_IDS; top -= DELETE_BATCH) {
      const ids: number[] = []
      for (let id = top; id > Math.max(0, top - DELETE_BATCH); id--)
        if (!this.isWaiting(id)) ids.push(id)
      // Messages older than two days can't be deleted by a bot; the rest still go.
      if (ids.length && token)
        await this.call(token, 'deleteMessages', { chat_id: chat, message_ids: ids }).catch(
          () => {},
        )
    }
    await this.send(chat, 'Cleared. Your sessions are untouched; /sessions picks one up again.')
  }

  private broadcast(text: string, buttons?: Button[][], sessionId?: string) {
    return Promise.all(this.saved.chats.map((c) => this.send(c, text, buttons, sessionId)))
  }

  private remember<K, V>(map: Map<K, V>, key: K, value: V) {
    map.set(key, value)
    if (map.size > REMEMBERED) map.delete(map.keys().next().value as K)
  }

  private button(label: string, pending: Pending): Button {
    const id = `b${++this.nextButton}`
    this.remember(this.buttons, id, pending)
    return { text: clip(label, 60), callback_data: id }
  }

  private titleOf(sessionId: string): string {
    return digest(this.options.host.readSession(sessionId))?.title || 'Session'
  }

  private async handle(token: string, update: Update) {
    const query = update.callback_query
    if (query) {
      const chat = query.message?.chat
      if (!chat || chat.type !== 'private' || !this.saved.chats.includes(chat.id)) return
      await this.call(token, 'answerCallbackQuery', { callback_query_id: query.id }).catch(() => {})
      const pending = query.data ? this.buttons.get(query.data) : undefined
      if (!pending) {
        await this.send(chat.id, 'That button has expired. Use the app for this one.')
        return
      }
      // Menus can be tapped again; one-shot answers cannot.
      if (pending.kind === 'approval' || pending.kind === 'answer') this.buttons.delete(query.data!)
      await this.resolve(chat.id, pending, query.message?.message_id)
      return
    }
    const message = update.message
    if (!message?.text || message.chat.type !== 'private') return
    const chat = message.chat.id
    const text = message.text.trim()
    if (this.saved.chats.includes(chat)) this.track(chat, message.message_id)
    if (!this.saved.chats.includes(chat)) {
      // Strangers get nothing but the chance to pair.
      if (/^\/pair(@\w+)?\s/.test(text)) await this.pair(chat, text.replace(/^\S+\s+/, ''))
      return
    }
    if (text.startsWith('/')) return this.command(chat, text)
    const answering =
      message.reply_to_message && this.questions.get(message.reply_to_message.message_id)
    if (answering) {
      this.questions.delete(message.reply_to_message!.message_id)
      await this.resolve(chat, { ...answering, label: text })
      return
    }
    const replied =
      message.reply_to_message && this.messages.get(message.reply_to_message.message_id)
    const draft = replied ? undefined : this.drafts.get(chat)
    if (draft) {
      this.drafts.delete(chat)
      await this.startIn(chat, draft, text)
      return
    }
    const target = replied ?? this.active.get(chat)
    if (!target) {
      await this.send(chat, 'No session selected. Use /new to start one, or /sessions to pick one.')
      return
    }
    await this.promptSession(chat, target, text)
  }

  private async pair(chat: number, given: string) {
    const code = this.pairCode
    if (!code || code.expires <= this.now()) {
      await this.send(chat, 'No pairing is open. Create a code on the host first.')
      return
    }
    if (given.trim() !== code.code) {
      if (++code.failures >= PAIR_ATTEMPTS) this.pairCode = undefined
      await this.send(chat, 'That code is not right.')
      return
    }
    this.pairCode = undefined
    this.saved.chats = [...new Set([...this.saved.chats, chat])]
    this.save()
    await this.send(chat, 'Paired. Send /help to see what you can do.')
  }

  private async command(chat: number, text: string) {
    const [raw = '', ...rest] = text.split(/\s+/)
    const name = raw.replace(/^\//, '').replace(/@\w+$/, '').toLowerCase()
    const args = rest.join(' ')
    const { host } = this.options
    switch (name) {
      case 'start':
      case 'help':
        return void (await this.send(
          chat,
          [
            '/new — pick a project, then say what to do (or /new <project> <task>)',
            '/projects — pick a project',
            '/sessions — pick a recent session to talk to',
            '/stop — interrupt the current session',
            '/clear — delete the chat clutter and start fresh',
            '/unpair — remove this chat',
            'Any other text goes to the current session. Reply to a message to answer that session.',
          ].join('\n'),
        ))
      case 'clear':
        return this.clear(chat)
      case 'unpair':
        this.saved.chats = this.saved.chats.filter((c) => c !== chat)
        this.active.delete(chat)
        this.save()
        return void (await this.send(chat, 'Unpaired. This chat can no longer control agents.'))
      case 'projects':
        return this.pickProject(chat)
      case 'sessions': {
        const ids = host.recentSessionIds(LIST_LENGTH).filter((id) => digest(host.readSession(id)))
        if (ids.length === 0) return void (await this.send(chat, 'No sessions yet.'))
        const rows = ids.map((id) => {
          const d = digest(host.readSession(id))!
          return [
            this.button(`${STATUS_ICON[d.status]} ${d.title || 'Session'}`, {
              kind: 'session',
              sessionId: id,
            }),
          ]
        })
        return void (await this.send(chat, 'Pick a session to talk to:', rows))
      }
      case 'stop': {
        const id = this.active.get(chat)
        if (!id) return void (await this.send(chat, 'No session selected.'))
        await host.interrupt(id).catch(() => {})
        return void (await this.send(chat, `Stopped "${this.titleOf(id)}".`))
      }
      case 'new':
        return this.newSession(chat, args)
      default:
        return void (await this.send(chat, 'Unknown command. Send /help.'))
    }
  }

  private select(chat: number, sessionId: string) {
    this.active.set(chat, sessionId)
    this.watched.add(sessionId)
  }

  /** Projects as buttons: the ones with recent sessions first, a dot on those working now. */
  private async pickProject(chat: number) {
    const { host } = this.options
    const paths = await host.projectPaths()
    if (paths.length === 0) return void (await this.send(chat, 'No projects yet.'))
    const recent = new Map<string, { rank: number; running: boolean }>()
    host.recentSessionIds(50).forEach((id, rank) => {
      const d = digest(host.readSession(id))
      if (!d) return
      const seen = recent.get(d.cwd)
      recent.set(d.cwd, {
        rank: seen?.rank ?? rank,
        running: !!seen?.running || d.status === 'running' || d.status === 'needs-you',
      })
    })
    const sorted = [...paths].sort(
      (a, b) => (recent.get(a)?.rank ?? Infinity) - (recent.get(b)?.rank ?? Infinity),
    )
    const buttons = sorted.map((cwd) =>
      this.button(`${recent.get(cwd)?.running ? '🟢 ' : ''}${path.basename(cwd)}`, {
        kind: 'project',
        cwd,
      }),
    )
    const rows: Button[][] = []
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2))
    await this.send(chat, 'Which project?', rows)
  }

  private async newSession(chat: number, args: string) {
    const [project = '', ...words] = args.split(/\s+/)
    const task = words.join(' ').trim()
    if (!project) return this.pickProject(chat)
    const paths = await this.options.host.projectPaths()
    const wanted = project.toLowerCase()
    const matches = paths.filter((p) => path.basename(p).toLowerCase() === wanted)
    const found =
      matches.length === 1
        ? matches
        : paths.filter((p) => path.basename(p).toLowerCase().includes(wanted))
    if (found.length !== 1) {
      return void (await this.send(
        chat,
        found.length === 0
          ? `No project matches "${project}". See /projects.`
          : `"${project}" matches ${found.length} projects; be more specific.`,
      ))
    }
    if (!task) return this.openCard(chat, found[0]!)
    await this.startIn(chat, this.draftFor(found[0]!), task)
  }

  private draftFor(cwd: string): Draft {
    return { ...this.saved.defaults, cwd }
  }

  /** The agent a draft will use: the one it names if it is ready, else the first ready one. */
  private async agentFor(draft: Draft): Promise<ProviderInstance | undefined> {
    const ready = (await this.options.host.providers()).filter((p) => p.status === 'ready')
    return ready.find((p) => p.id === draft.instanceId) ?? ready[0]
  }

  private async openCard(chat: number, cwd: string, messageId?: number) {
    this.drafts.set(chat, this.draftFor(cwd))
    await this.showCard(chat, messageId)
  }

  /** The setup card: where and how the next session will run, each part a button. */
  private async showCard(chat: number, messageId?: number) {
    const draft = this.drafts.get(chat)
    if (!draft) return void (await this.send(chat, 'That setup expired. Send /new to start again.'))
    const agent = await this.agentFor(draft)
    if (!agent) return void (await this.send(chat, 'No agent is ready on the host.'))
    const model = agent.capabilities.models?.find((m) => m.id === draft.model)
    const mode = agent.capabilities.permissionModes.find((m) => m.id === draft.permissionMode)
    const text = [
      `New session on ${this.options.host.hostLabel}`,
      `Project: ${path.basename(draft.cwd)}`,
      `Agent: ${agent.label}`,
      `Model: ${model?.label ?? draft.model ?? 'default'}`,
      `Effort: ${draft.effort ?? 'default'}`,
      `Permissions: ${mode?.label ?? draft.permissionMode ?? 'default'}`,
      '',
      'Change anything below, then send the task as your next message to start.',
    ].join('\n')
    const fields: Field[] = ['project', 'agent']
    if (agent.capabilities.models?.length) fields.push('model')
    if ((model?.efforts ?? agent.capabilities.efforts)?.length) fields.push('effort')
    if (agent.capabilities.permissionModes.length) fields.push('mode')
    const buttons = fields.map((field) =>
      this.button(`${FIELD_LABEL[field]} ▾`, { kind: 'menu', field }),
    )
    const rows: Button[][] = []
    for (let i = 0; i < buttons.length; i += 2) rows.push(buttons.slice(i, i + 2))
    await this.showOrSend(chat, messageId, text, rows)
  }

  private async showOrSend(
    chat: number,
    messageId: number | undefined,
    text: string,
    rows: Button[][],
  ) {
    const token = this.token
    if (token && messageId !== undefined) {
      try {
        await this.call(token, 'editMessageText', {
          chat_id: chat,
          message_id: messageId,
          text: clip(text),
          reply_markup: { inline_keyboard: rows },
        })
        return
      } catch {
        // Unchanged or too old to edit: send a new one.
      }
    }
    await this.send(chat, text, rows)
  }

  /** The choices for one part of the card, with the current one marked. */
  private async showMenu(chat: number, field: Field, messageId?: number) {
    const draft = this.drafts.get(chat)
    if (!draft) return void (await this.send(chat, 'That setup expired. Send /new to start again.'))
    const agent = await this.agentFor(draft)
    if (!agent) return
    const choices: { label: string; value?: string }[] = []
    let current: string | undefined
    if (field === 'project') {
      current = draft.cwd
      const paths = await this.options.host.projectPaths()
      choices.push(...paths.map((cwd) => ({ label: path.basename(cwd), value: cwd })))
    } else if (field === 'agent') {
      current = agent.id
      const ready = (await this.options.host.providers()).filter((p) => p.status === 'ready')
      choices.push(...ready.map((p) => ({ label: p.label, value: p.id })))
    } else {
      choices.push({ label: 'Default' })
      if (field === 'model') {
        current = draft.model
        choices.push(
          ...(agent.capabilities.models ?? []).map((m) => ({ label: m.label, value: m.id })),
        )
      } else if (field === 'effort') {
        current = draft.effort
        const model = agent.capabilities.models?.find((m) => m.id === draft.model)
        const efforts = model?.efforts ?? agent.capabilities.efforts ?? []
        choices.push(...efforts.map((e) => ({ label: e, value: e })))
      } else {
        current = draft.permissionMode
        choices.push(
          ...agent.capabilities.permissionModes.map((m) => ({
            label: `${m.dangerous ? '⚠️ ' : ''}${m.label}`,
            value: m.id,
          })),
        )
      }
    }
    const rows = choices.map((c) => [
      this.button(`${c.value === current ? '✓ ' : ''}${c.label}`, {
        kind: 'choose',
        field,
        value: c.value,
      }),
    ])
    rows.push([this.button('‹ Back', { kind: 'card' })])
    await this.showOrSend(chat, messageId, `${FIELD_LABEL[field]}:`, rows)
  }

  private async choose(chat: number, field: Field, value: string | undefined, messageId?: number) {
    const draft = this.drafts.get(chat)
    if (!draft) return void (await this.send(chat, 'That setup expired. Send /new to start again.'))
    if (field === 'project') {
      if (value) draft.cwd = value
    } else if (field === 'agent') {
      // Models, efforts and modes belong to one agent.
      Object.assign(draft, {
        instanceId: value,
        model: undefined,
        effort: undefined,
        permissionMode: undefined,
      })
    } else if (field === 'model') {
      draft.model = value
      const agent = await this.agentFor(draft)
      const efforts = agent?.capabilities.models?.find((m) => m.id === value)?.efforts
      if (draft.effort && efforts && !efforts.includes(draft.effort)) draft.effort = undefined
    } else if (field === 'effort') {
      draft.effort = value
    } else {
      draft.permissionMode = value
    }
    await this.showCard(chat, messageId)
  }

  private async startIn(chat: number, draft: Draft, task: string) {
    const agent = await this.agentFor(draft)
    if (!agent) return void (await this.send(chat, 'No agent is available on the host.'))
    const { sessionId } = await this.options.host.create({
      instanceId: agent.id,
      cwd: draft.cwd,
      title: clip(task, 60),
      model: draft.model,
      effort: draft.effort,
      permissionMode: draft.permissionMode,
    })
    this.saved.defaults = {
      instanceId: agent.id,
      model: draft.model,
      effort: draft.effort,
      permissionMode: draft.permissionMode,
    }
    this.save()
    this.select(chat, sessionId)
    const how = [agent.label, draft.model, draft.effort].filter(Boolean).join(' · ')
    await this.send(
      chat,
      `Started "${clip(task, 60)}" in ${path.basename(draft.cwd)} (${how}).`,
      undefined,
      sessionId,
    )
    await this.options.host.prompt(sessionId, task)
  }

  private async promptSession(chat: number, sessionId: string, text: string) {
    this.select(chat, sessionId)
    try {
      await this.options.host.prompt(sessionId, text)
      await this.send(chat, `Sent to "${this.titleOf(sessionId)}".`, undefined, sessionId)
    } catch (err) {
      await this.send(chat, `Could not send: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  private async resolve(chat: number, pending: Pending, messageId?: number) {
    const { host } = this.options
    if (pending.kind === 'project') return this.openCard(chat, pending.cwd, messageId)
    if (pending.kind === 'menu') return this.showMenu(chat, pending.field, messageId)
    if (pending.kind === 'choose') return this.choose(chat, pending.field, pending.value, messageId)
    if (pending.kind === 'card') return this.showCard(chat, messageId)
    if (pending.kind === 'session') {
      this.drafts.delete(chat)
      this.select(chat, pending.sessionId)
      return void (await this.send(
        chat,
        `Now talking to "${this.titleOf(pending.sessionId)}". Send a message.`,
        undefined,
        pending.sessionId,
      ))
    }
    try {
      if (pending.kind === 'approval') {
        await host.approve(pending.sessionId, pending.requestId, pending.optionId)
      } else {
        await host.answer(pending.sessionId, pending.requestId, {
          [pending.questionId]: [pending.label],
        })
      }
      await this.send(chat, 'Done.')
    } catch (err) {
      await this.send(
        chat,
        `Could not do that: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** Tells the chats what a watched session needs or did. */
  async onEvent(stored: StoredEvent) {
    const { event } = stored
    if (this.saved.chats.length === 0 || !this.watched.has(event.sessionId)) return
    const events = this.options.host.readSession(event.sessionId)
    const d = digest(events)
    const title = d?.title || 'Session'
    if (event.type === 'turn.completed') {
      if (event.reason === 'cancelled') return
      const body =
        event.reason === 'done'
          ? d?.lastReply.trim() || 'Finished.'
          : `Stopped with an error${event.message ? `: ${event.message}` : ''}`
      await this.broadcast(
        `${event.reason === 'done' ? '✅' : '⚠️'} ${title}\n\n${body}`,
        undefined,
        event.sessionId,
      )
    } else if (event.type === 'approval.requested') {
      const rows = event.options.map((o) => [
        this.button(o.label, {
          kind: 'approval',
          sessionId: event.sessionId,
          requestId: event.requestId,
          optionId: o.id,
        }),
      ])
      const detail = event.detail ? `\n\n${event.detail}` : ''
      await this.broadcast(
        `🔐 ${title} needs approval:\n${event.title}${detail}`,
        rows,
        event.sessionId,
      )
    } else if (event.type === 'question.requested') {
      const [q, ...more] = event.questions
      if (!q) return
      const pending = (label: string) =>
        ({
          kind: 'answer',
          sessionId: event.sessionId,
          requestId: event.requestId,
          questionId: q.id,
          label,
        }) as const
      // Only a single question fits a chat; several are answered in the app.
      if (more.length > 0 || q.multiSelect || q.secret) {
        await this.broadcast(
          `❓ ${title} has questions. Answer them in the app.`,
          undefined,
          event.sessionId,
        )
        return
      }
      const rows = (q.options ?? []).map((o) => [this.button(o.label, pending(o.label))])
      const ids = await this.broadcast(
        `❓ ${title}:\n${q.question}${q.allowOther === false ? '' : '\n\nReply to this message to answer in your own words.'}`,
        rows.length ? rows : undefined,
        event.sessionId,
      )
      if (q.allowOther !== false)
        for (const id of ids) if (id !== undefined) this.remember(this.questions, id, pending(''))
    }
  }
}

const STATUS_ICON: Record<SessionDigest['status'], string> = {
  starting: '⏳',
  running: '🟢',
  'needs-you': '🔔',
  idle: '⚪',
  error: '🔴',
  cancelled: '⚪',
}
