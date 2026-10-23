import type {
  ProviderCapabilities,
  ProviderInstance,
  SessionEvent,
  SlashCommand,
} from '@beddcode/contracts'
import { createAsyncQueue, deferred, sleep, type Deferred } from '@beddcode/shared'
import type {
  HistoryItem,
  HistoryTurn,
  ProviderAdapter,
  ProviderSession,
  PromptInput,
  StartSessionInput,
} from './adapter.ts'

export const FAKE_INSTANCE_ID = 'fake'

const baseCapabilities: ProviderCapabilities = {
  textGeneration: true,
  resume: false,
  fork: false,
  steer: false,
  planMode: false,
  imageInput: false,
  usage: false,
  permissionModes: [
    { id: 'ask', label: 'Ask before edits', description: 'Asks before running commands' },
    { id: 'full', label: 'Full access', dangerous: true },
  ],
}

export interface FakeAdapterOptions {
  /** Pause between scripted steps. Tests pass 0. */
  delayMs?: number
  /** Accept messages sent while a turn runs, and announce the extras below. Off by default. */
  advanced?: boolean
  /** Called with the input of every session started, so tests can see what the host passed. */
  onStart?: (input: StartSessionInput) => void
  /** Conversations the fake agent "has on disk", for history and fork tests. */
  history?: (HistoryItem & { turns: HistoryTurn[] })[]
}

/**
 * A scripted provider used for development and tests. Each prompt streams a reply, runs a fake
 * command, edits a file, and (in "ask" mode) waits for the user to answer an approval request.
 */
export function createFakeAdapter(options: FakeAdapterOptions = {}): ProviderAdapter {
  const delayMs = options.delayMs ?? 40
  const advanced = options.advanced === true
  const capabilities: ProviderCapabilities = advanced
    ? {
        ...baseCapabilities,
        resume: true,
        fork: true,
        steer: true,
        planMode: true,
        questions: true,
        commands: true,
        history: true,
        models: [
          { id: 'fast', label: 'Fast' },
          { id: 'smart', label: 'Smart' },
        ],
      }
    : baseCapabilities
  const stored = options.history ?? []

  return {
    generateText: async ({ prompt }) =>
      prompt.includes('"message"')
        ? JSON.stringify({
            message: 'feat: update workspace behavior\n\nImprove the selected files.',
          })
        : JSON.stringify({
            title: 'Improve workspace behavior',
            body: '## Summary\n\nImprove workspace behavior.\n\n## Testing\n\nNot run by the description generator.',
          }),
    kind: 'fake',
    async detect(): Promise<ProviderInstance[]> {
      return [
        {
          id: FAKE_INSTANCE_ID,
          kind: 'fake',
          label: 'Fake agent',
          status: 'ready',
          version: '0.0.0',
          capabilities,
        },
      ]
    },
    capabilities: () => capabilities,
    async startSession(_instanceId, input) {
      options.onStart?.(input)
      return new FakeSession(input, delayMs, advanced)
    },
    ...(advanced
      ? {
          async listHistory() {
            return stored.map(({ id, title, updatedAt, cwd }) => ({ id, title, updatedAt, cwd }))
          },
          async readHistory(_instanceId: string, id: string) {
            const found = stored.find((h) => h.id === id)
            if (!found) throw new Error('No such conversation')
            return found.turns
          },
          async forkHistory(
            _instanceId: string,
            from: { providerSessionId: string; throughTurn?: number },
          ) {
            // A conversation that was never stored (a live session) forks to an empty copy.
            const found = stored.find((h) => h.id === from.providerSessionId)
            const id = `${from.providerSessionId}-fork-${stored.length}`
            stored.push({
              id,
              title: found?.title ?? id,
              turns: found?.turns.slice(0, from.throughTurn) ?? [],
            })
            return id
          },
          async listCommands(): Promise<SlashCommand[]> {
            return [{ name: 'review', description: 'Review the changes', kind: 'command' }]
          },
        }
      : {}),
  }
}

class FakeSession implements ProviderSession {
  readonly sessionId: string
  private readonly queue = createAsyncQueue<SessionEvent>()
  private readonly pending = new Map<string, Deferred<string>>()
  private abort = new AbortController()
  private permissionMode: string
  private turnCount = 0
  private idCounter = 0

  constructor(
    input: StartSessionInput,
    private readonly delayMs: number,
    private readonly advanced: boolean,
  ) {
    this.sessionId = input.sessionId
    this.permissionMode = input.permissionMode ?? 'ask'
    if (advanced) {
      this.setModel = async (model, effort) => {
        this.models.push({ model, effort })
      }
      this.steer = async (input) => {
        this.steered.push(input.text)
      }
      this.answerQuestion = async (requestId, answers) => {
        const waiting = this.questions.get(requestId)
        if (!waiting) throw new Error(`No pending question ${requestId}`)
        waiting.resolve(answers)
      }
      this.emit({
        type: 'session.provider-session',
        providerSessionId: input.resumeId ?? input.sessionId,
      })
      this.emit({
        type: 'session.commands',
        commands: [{ name: 'review', description: 'Review the changes', kind: 'command' }],
      })
    }
  }

  /** Messages that reached the running turn (tests read this). */
  readonly steered: string[] = []
  private readonly questions = new Map<string, Deferred<Record<string, string[]> | undefined>>()

  /** Models chosen during the session, newest last (tests read this). */
  readonly models: { model: string | undefined; effort: string | undefined }[] = []
  setModel?: (model: string | undefined, effort: string | undefined) => Promise<void>
  /** Only the advanced fake can be steered or asked questions, like the real agents that can. */
  steer?: (input: PromptInput) => Promise<void>
  answerQuestion?: (requestId: string, answers?: Record<string, string[]>) => Promise<void>

  get events() {
    return this.queue
  }

  private emit(event: DistributiveOmit<SessionEvent, 'sessionId' | 'at'>, turnId?: string) {
    this.queue.push({ ...event, sessionId: this.sessionId, turnId, at: Date.now() } as SessionEvent)
  }

  async prompt(input: PromptInput): Promise<void> {
    const signal = (this.abort = new AbortController()).signal
    const turnId = `turn-${++this.turnCount}`
    this.emit({ type: 'turn.started' }, turnId)

    const say = async (text: string) => {
      for (const chunk of text.match(/\S+\s*/g) ?? []) {
        if (signal.aborted) return
        this.emit({ type: 'message.delta', role: 'assistant', text: chunk }, turnId)
        await sleep(this.delayMs / 4, signal)
      }
    }

    if (this.advanced && input.text.includes('[plan]')) {
      this.emit(
        {
          type: 'plan.updated',
          steps: [
            { text: 'Find the bug', status: 'completed' },
            { text: 'Fix it', status: 'in-progress' },
            { text: 'Add a test', status: 'pending' },
          ],
        },
        turnId,
      )
    }
    if (this.advanced && input.text.includes('[question]')) {
      const requestId = `q-${++this.idCounter}`
      const answer = deferred<Record<string, string[]> | undefined>()
      this.questions.set(requestId, answer)
      this.emit(
        {
          type: 'question.requested',
          requestId,
          questions: [
            {
              id: 'db',
              header: 'Database',
              question: 'Which database?',
              options: [{ label: 'Postgres' }, { label: 'SQLite' }],
            },
          ],
        },
        turnId,
      )
      signal.addEventListener('abort', () => answer.resolve(undefined), { once: true })
      const answers = await answer.promise
      this.questions.delete(requestId)
      this.emit({ type: 'question.resolved', requestId, answers }, turnId)
    }
    if (this.advanced && input.text.includes('[slow]')) {
      await sleep(this.delayMs * 10, signal)
    }

    await say(`Looking into "${input.text}". Let me check the code first.`)
    await this.runTool(turnId, signal, 'command', 'Running Bash: grep -rn "refill" src/')
    await say(' Found the cause. Applying a fix.')
    if (signal.aborted) return this.finish(turnId, 'cancelled')

    this.emit(
      {
        type: 'diff',
        path: 'src/limiter/token-bucket.ts',
        added: 4,
        removed: 1,
        patch:
          '-  const elapsed = now - bucket.refillAt\n+  const elapsed = Math.max(0, now - bucket.refillAt)',
      },
      turnId,
    )
    await sleep(this.delayMs, signal)

    if (this.permissionMode === 'ask') {
      const requestId = `req-${++this.idCounter}`
      const answer = deferred<string>()
      this.pending.set(requestId, answer)
      this.emit(
        {
          type: 'approval.requested',
          requestId,
          title: 'Run the new test?',
          detail: 'pnpm vitest run test/limiter',
          options: [
            { id: 'allow', label: 'Allow', kind: 'allow' },
            { id: 'deny', label: 'Deny', kind: 'deny' },
            { id: 'allow-session', label: 'Always for this session', kind: 'allow' },
          ],
        },
        turnId,
      )
      signal.addEventListener('abort', () => answer.resolve('deny'), { once: true })
      const optionId = await answer.promise
      this.pending.delete(requestId)
      this.emit({ type: 'approval.resolved', requestId, optionId }, turnId)
      if (optionId === 'deny') {
        await say(' Understood, I will not run the test.')
        return this.finish(turnId, signal.aborted ? 'cancelled' : 'done')
      }
    }

    await this.runTool(turnId, signal, 'command', 'Running Bash: pnpm vitest run test/limiter')
    await say(' All tests pass.')
    this.finish(turnId, signal.aborted ? 'cancelled' : 'done')
  }

  private async runTool(
    turnId: string,
    signal: AbortSignal,
    kind: 'command' | 'read' | 'edit' | 'search' | 'other',
    title: string,
  ) {
    const toolId = `tool-${++this.idCounter}`
    this.emit({ type: 'tool.started', toolId, kind, title }, turnId)
    await sleep(this.delayMs, signal)
    this.emit({ type: 'tool.completed', toolId, ok: true }, turnId)
  }

  private finish(turnId: string, reason: 'done' | 'cancelled' | 'error') {
    this.emit({ type: 'turn.completed', reason }, turnId)
  }

  async interrupt() {
    this.abort.abort()
  }

  async setPermissionMode(modeId: string) {
    this.permissionMode = modeId
  }

  async respondToApproval(requestId: string, optionId: string) {
    const waiting = this.pending.get(requestId)
    if (!waiting) throw new Error(`No pending approval ${requestId}`)
    waiting.resolve(optionId)
  }

  async close() {
    this.abort.abort()
    this.queue.close()
  }
}

type DistributiveOmit<T, K extends keyof never> = T extends unknown ? Omit<T, K> : never
