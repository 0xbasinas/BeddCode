import type { SessionEvent } from '@beddcode/contracts'

type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'sessionId' | 'at' | 'turnId'> : never
type Obj = Record<string, unknown>
type ToolState = { name: string; args: Obj; kind: 'command' | 'read' | 'edit' | 'search' | 'other' }
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => typeof v === 'string' && v ? v : undefined
const cap = (s: string, n = 4000) => s.length > n ? s.slice(-n) : s

function kindOf(name: string): ToolState['kind'] {
  if (/bash|shell|command/i.test(name)) return 'command'
  if (/read|ls|list|grep|find/i.test(name)) return 'read'
  if (/edit|write|patch/i.test(name)) return 'edit'
  if (/search|web|fetch/i.test(name)) return 'search'
  return 'other'
}

function textOf(value: unknown): string | undefined {
  if (!Array.isArray(value)) return typeof value === 'string' ? cap(value) : undefined
  const text = value.flatMap((c) => isObj(c) && c.type === 'text' && typeof c.text === 'string' ? [c.text] : []).join('\n')
  return text ? cap(text) : undefined
}

/** Maps Pi RPC events into BeddCode's provider-neutral transcript events. */
export class PiEventMapper {
  private turnId?: string
  private readonly tools = new Map<string, ToolState>()
  constructor(private readonly sessionId: string, private readonly now = Date.now) {}
  setTurn(turnId?: string) { this.turnId = turnId }
  private stamp(drafts: Draft[]): SessionEvent[] {
    return drafts.map((e) => ({ ...e, sessionId: this.sessionId, turnId: this.turnId, at: this.now() }) as SessionEvent)
  }
  abandonTools() {
    const out: Draft[] = []
    for (const [toolId] of this.tools) out.push({ type: 'tool.completed', toolId, ok: false, approval: 'not-asked' })
    this.tools.clear()
    return this.stamp(out)
  }
  map(event: Obj): SessionEvent[] {
    const out: Draft[] = []
    if (event.type === 'message_update' && isObj(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent
      if (update.type === 'text_delta' && typeof update.delta === 'string' && update.delta) out.push({ type: 'message.delta', role: 'assistant', text: update.delta })
      if (update.type === 'toolcall_end' && isObj(update.toolCall)) this.toolStart(update.toolCall, out)
    }
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') this.toolStart({ id: event.toolCallId, name: event.toolName, arguments: event.args }, out)
    if (event.type === 'tool_execution_update' && typeof event.toolCallId === 'string') {
      const state = this.tools.get(event.toolCallId)
      const output = isObj(event.partialResult) ? textOf(event.partialResult.content) : undefined
      if (state && output) out.push({ type: 'tool.output', toolId: event.toolCallId, data: output })
    }
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
      const id = event.toolCallId
      const state = this.tools.get(id)
      const result = isObj(event.result) ? event.result : {}
      const output = textOf(result.content)
      out.push({ type: 'tool.completed', toolId: id, ok: event.isError !== true, output, approval: 'not-asked' })
      this.tools.delete(id)
    }
    if (event.type === 'compaction_start') out.push({ type: 'session.compaction', state: 'started', trigger: 'auto' })
    if (event.type === 'compaction_end') out.push({ type: 'session.compaction', state: event.aborted === true ? 'failed' : 'finished', trigger: 'auto' })
    return this.stamp(out)
  }
  private toolStart(tool: Obj, out: Draft[]) {
    const id = str(tool.id) ?? str(tool.toolCallId)
    const name = str(tool.name) ?? str(tool.toolName) ?? 'Tool'
    if (!id || this.tools.has(id)) return
    const args = isObj(tool.arguments) ? tool.arguments : isObj(tool.args) ? tool.args : {}
    const kind = kindOf(name)
    this.tools.set(id, { name, args, kind })
    const command = kind === 'command' ? str(args.command) : undefined
    const paths = Object.values(args).flatMap((v) => typeof v === 'string' && /\.[\w-]+$/.test(v) ? [v] : [])
    out.push({ type: 'tool.started', toolId: id, kind, title: (command ?? name).slice(0, 200), input: JSON.stringify(args, null, 2).slice(0, 4000), ...(command ? { command } : {}), ...(paths.length ? { paths } : {}) })
  }
}

