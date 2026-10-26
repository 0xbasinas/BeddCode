import { randomBytes } from 'node:crypto'
import path from 'node:path'
import {
  isBrowserToolName,
  type PermissionModeOption,
  type ProviderInstance,
  type RpcParams,
  type StoredEvent,
} from '@beddcode/contracts'
import type { SessionMcpServer } from '@beddcode/provider-core'
import type { SessionOrigin } from '../sessions/sessionManager.ts'
import { BROWSER_INSTRUCTIONS, BROWSER_TOOL_DEFINITIONS, type BrowserTools } from './browserUse.ts'
import {
  DESIGN_INSTRUCTIONS,
  DESIGN_TOOL_DEFINITIONS,
  isDesignToolName,
  type DesignTools,
} from '../design/designTools.ts'
import { digest, transcript, type SessionDigest } from './digest.ts'

/** How deep sessions may nest: a child (1) may start children of its own (2), and those none. */
export const MAX_DEPTH = 2
/** Children one session may have running at once, and over its whole life. */
export const MAX_ACTIVE_CHILDREN = 5
export const MAX_TOTAL_CHILDREN = 10
const WAIT_DEFAULT_S = 120
/** Agents' MCP clients give up on a call after about five minutes; answer before that. */
const WAIT_MAX_S = 240

/** What the tools need from the rest of the host. */
export interface AgentToolsHost {
  create(
    params: RpcParams<'sessions.create'>,
    origin: SessionOrigin,
  ): Promise<{ sessionId: string }>
  prompt(sessionId: string, text: string): Promise<unknown>
  interrupt(sessionId: string): Promise<void>
  isBusy(sessionId: string): boolean
  currentMode(sessionId: string): string | undefined
  providers(): Promise<ProviderInstance[]>
  readSession(sessionId: string): StoredEvent[]
  childrenOf(sessionId: string): string[]
  /** Called with each new event, to wake waiting calls. Returns an unsubscribe function. */
  subscribe(listener: (stored: StoredEvent) => void): () => void
  /** Folders a child may be started in, besides its parent's own. */
  projectPaths(): Promise<string[]>
}

/**
 * How much a permission mode lets an agent do without asking: 0 read or plan only, 1 asks first,
 * 2 edits on its own, 3 anything. Compared across agents, whose modes have different names.
 */
export function modeLevel(
  mode: Pick<PermissionModeOption, 'id' | 'label' | 'dangerous'> | string,
): number {
  const m = typeof mode === 'string' ? { id: mode, label: mode, dangerous: false } : mode
  const text = `${m.id} ${m.label}`.toLowerCase()
  if (m.dangerous || /bypass|full|yolo|danger|never ask|skip/.test(text)) return 3
  if (/plan|read/.test(text)) return 0
  if (/\bask|before|default|approv|manual/.test(text)) return 1
  if (/accept|auto|edit|write|agent/.test(text)) return 2
  return 1
}

/** The tools, as MCP lists them. */
export const TOOL_DEFINITIONS = [
  {
    name: 'list_agents',
    description:
      'Lists the coding agents this BeddCode host can start, with their models and permission modes.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'start_session',
    description:
      'Starts another agent in a new BeddCode session and sends it a first message. The user sees it nested under this session and answers its approvals. Returns its session_id; use wait_for to get its answer.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: {
          type: 'string',
          description: 'Agent id from list_agents, e.g. "codex" or "claude".',
        },
        prompt: { type: 'string', description: 'The task for the new session.' },
        title: { type: 'string', description: 'A short name for the session.' },
        model: { type: 'string', description: 'Model id; the agent default when omitted.' },
        mode: {
          type: 'string',
          description:
            'Permission mode id. It cannot allow more than this session is allowed; the closest allowed mode is used when omitted.',
        },
        folder: {
          type: 'string',
          description:
            "Folder to work in; this session's folder when omitted. Must be a BeddCode project.",
        },
        worktree: {
          type: 'boolean',
          description:
            'Work in a new git worktree of the folder, so changes stay apart from yours.',
        },
      },
      required: ['agent', 'prompt'],
    },
  },
  {
    name: 'send_message',
    description: 'Sends a follow-up message to one of your sessions (queued if it is busy).',
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, text: { type: 'string' } },
      required: ['session_id', 'text'],
    },
  },
  {
    name: 'get_status',
    description: "One of your sessions' status and its latest reply.",
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'read_transcript',
    description: 'The conversation of one of your sessions as text, newest part when long.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        max_chars: { type: 'number', description: 'Defaults to 8000.' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'wait_for',
    description: `Waits until one of your sessions finishes its turn or needs the user, then returns its status and reply. Waits at most timeout_seconds (default ${WAIT_DEFAULT_S}, max ${WAIT_MAX_S}); call again if it is still running.`,
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' }, timeout_seconds: { type: 'number' } },
      required: ['session_id'],
    },
  },
  {
    name: 'stop',
    description: "Stops one of your sessions' current turn.",
    inputSchema: {
      type: 'object',
      properties: { session_id: { type: 'string' } },
      required: ['session_id'],
    },
  },
  {
    name: 'list_children',
    description: 'The sessions you started, with their status.',
    inputSchema: { type: 'object', properties: {} },
  },
] as const

export const INSTRUCTIONS =
  'BeddCode agent tools: start other coding agents (start_session), then wait_for their answer. ' +
  'They work in their own sessions the user can see; the user answers their approvals.'

type Args = Record<string, unknown>

const str = (args: Args, key: string, required = false): string | undefined => {
  const v = args[key]
  if (typeof v === 'string' && v.trim()) return v.trim()
  if (required) throw new Error(`"${key}" is required`)
  return undefined
}

const brief = (d: SessionDigest) => ({
  session_id: d.sessionId,
  title: d.title,
  agent: d.instanceId,
  status: d.status,
  folder: d.cwd,
  ...(d.branch ? { branch: d.branch } : {}),
  ...(d.waitingOn ? { waiting_on: `${d.waitingOn} (the user answers this in BeddCode)` } : {}),
  ...(d.lastError ? { last_error: d.lastError } : {}),
})

export class AgentTools {
  private readonly tokens = new Map<string, string>()
  private readonly bySession = new Map<string, string>()
  /** The last request of each child that wait_for already told its parent about. */
  private readonly reported = new Map<string, number>()

  constructor(
    private readonly host: AgentToolsHost,
    private readonly bridge: { file: string; url: () => string; execPath?: string },
    private readonly browser?: BrowserTools,
    private readonly design?: DesignTools,
  ) {}

  /** Which tool sets a session was given when it was created. */
  private features(sessionId: string): { agents: boolean; browser: boolean; design: boolean } {
    const created = this.host.readSession(sessionId).find((e) => e.event.type === 'session.created')
    const event = created?.event.type === 'session.created' ? created.event : undefined
    return {
      // The server is only given to sessions with one of the three; without the other flags it
      // was for the agent tools.
      agents:
        event?.agentTools === true || (event?.browserTools !== true && event?.designTools !== true),
      browser: event?.browserTools === true && this.browser !== undefined,
      design: event?.designTools === true && this.design !== undefined,
    }
  }

  /** The MCP server to give a session that may use the tools. */
  serversFor(sessionId: string): SessionMcpServer[] {
    let token = this.bySession.get(sessionId)
    if (!token) {
      token = randomBytes(24).toString('base64url')
      this.tokens.set(token, sessionId)
      this.bySession.set(sessionId, token)
    }
    return [
      {
        name: 'beddcode',
        command: this.bridge.execPath ?? process.execPath,
        args: [this.bridge.file],
        env: {
          BEDDCODE_TOOLS_URL: this.bridge.url(),
          BEDDCODE_TOOLS_TOKEN: token,
          // Inside the desktop app the executable is Electron; this makes it act as Node.
          ELECTRON_RUN_AS_NODE: '1',
        },
      },
    ]
  }

  /** The session a bearer token belongs to. */
  sessionFor(token: string | undefined): string | undefined {
    return token ? this.tokens.get(token) : undefined
  }

  /** One request from the bridge. */
  async handle(sessionId: string, method: string, params: unknown): Promise<unknown> {
    const has = this.features(sessionId)
    if (method === 'instructions')
      return [
        has.agents && INSTRUCTIONS,
        has.browser && BROWSER_INSTRUCTIONS,
        has.design && DESIGN_INSTRUCTIONS,
      ]
        .filter(Boolean)
        .join('\n\n')
    if (method === 'tools/list')
      return {
        tools: [
          ...(has.agents ? TOOL_DEFINITIONS : []),
          ...(has.browser ? BROWSER_TOOL_DEFINITIONS : []),
          ...(has.design ? DESIGN_TOOL_DEFINITIONS : []),
        ],
      }
    if (method !== 'tools/call') throw new Error(`Unknown method ${method}`)
    const p = (params ?? {}) as { name?: string; arguments?: Args }
    const name = String(p.name)
    if (isBrowserToolName(name)) {
      if (!has.browser || !this.browser)
        return {
          content: [{ type: 'text', text: 'This session may not use the browser.' }],
          isError: true,
        }
      return this.browser.call(sessionId, name, p.arguments ?? {})
    }
    if (isDesignToolName(name)) {
      if (!has.design || !this.design)
        return {
          content: [{ type: 'text', text: 'This session may not use the design canvas.' }],
          isError: true,
        }
      return this.design.callAsync(name, p.arguments ?? {})
    }
    if (!has.agents)
      return {
        content: [{ type: 'text', text: `Unknown tool ${name}` }],
        isError: true,
      }
    try {
      const result = await this.call(sessionId, name, p.arguments ?? {})
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
    } catch (err) {
      return {
        content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
        isError: true,
      }
    }
  }

  private self(sessionId: string): SessionDigest {
    const d = digest(this.host.readSession(sessionId))
    if (!d) throw new Error('This session no longer exists')
    return d
  }

  /** A session the caller started; nobody may drive sessions that are not theirs. */
  private child(parentId: string, args: Args): SessionDigest {
    const id = str(args, 'session_id', true)!
    const d = digest(this.host.readSession(id))
    if (!d || d.parentSessionId !== parentId)
      throw new Error(`${id} is not a session you started (see list_children)`)
    return d
  }

  async call(sessionId: string, name: string, args: Args): Promise<unknown> {
    switch (name) {
      case 'list_agents': {
        const providers = await this.host.providers()
        return providers
          .filter((p) => p.status === 'ready')
          .map((p) => ({
            agent: p.id,
            label: p.label,
            models: p.capabilities.models?.map((m) => m.id) ?? [],
            modes: p.capabilities.permissionModes.map((m) => m.id),
          }))
      }
      case 'start_session':
        return this.start(sessionId, args)
      case 'send_message': {
        const child = this.child(sessionId, args)
        const state = await this.host.prompt(child.sessionId, str(args, 'text', true)!)
        return { session_id: child.sessionId, ...(state as object) }
      }
      case 'get_status': {
        const child = this.child(sessionId, args)
        return { ...brief(child), last_reply: child.lastReply.slice(-4_000) }
      }
      case 'read_transcript': {
        const child = this.child(sessionId, args)
        const max = Math.min(Math.max(Number(args.max_chars) || 8_000, 500), 40_000)
        return {
          ...brief(child),
          transcript: transcript(this.host.readSession(child.sessionId), max),
        }
      }
      case 'wait_for':
        return this.wait(sessionId, args)
      case 'stop': {
        const child = this.child(sessionId, args)
        await this.host.interrupt(child.sessionId).catch(() => {})
        return { session_id: child.sessionId, stopped: true }
      }
      case 'list_children':
        return this.host
          .childrenOf(sessionId)
          .map((id) => digest(this.host.readSession(id)))
          .filter((d): d is SessionDigest => d !== undefined)
          .map(brief)
      default:
        throw new Error(`Unknown tool ${name}`)
    }
  }

  private async start(parentId: string, args: Args) {
    const parent = this.self(parentId)
    const depth = parent.depth + 1
    if (depth > MAX_DEPTH)
      throw new Error(`Sessions can nest ${MAX_DEPTH} deep; this one cannot start more`)
    const children = this.host.childrenOf(parentId)
    if (children.length >= MAX_TOTAL_CHILDREN)
      throw new Error(`A session can start at most ${MAX_TOTAL_CHILDREN} others`)
    const active = children.filter((id) => {
      const d = digest(this.host.readSession(id))
      return this.host.isBusy(id) || d?.status === 'running' || d?.status === 'needs-you'
    })
    if (active.length >= MAX_ACTIVE_CHILDREN)
      throw new Error(
        `${MAX_ACTIVE_CHILDREN} of your sessions are still working; wait for one first`,
      )

    const agentId = str(args, 'agent', true)!
    const providers = await this.host.providers()
    const agent =
      providers.find((p) => p.id === agentId) ??
      providers.find((p) => p.label.toLowerCase() === agentId.toLowerCase())
    if (!agent) throw new Error(`No agent "${agentId}" here (see list_agents)`)
    if (agent.status !== 'ready') throw new Error(`${agent.label} is not ready on this host`)

    const permissionMode = this.childMode(parentId, parent, agent, str(args, 'mode'))
    const created = this.host.readSession(parentId).find((e) => e.event.type === 'session.created')
    const parentProject =
      created?.event.type === 'session.created' ? created.event.projectPath : undefined
    const worktree = args.worktree === true
    // A session without a project has only a scratch folder; its children stay without a project
    // too, so they list beside it instead of under a project named after that folder.
    const projectless =
      created?.event.type === 'session.created' &&
      created.event.projectless === true &&
      !str(args, 'folder') &&
      !worktree
    const folder = projectless
      ? parent.cwd
      : await this.childFolder(str(args, 'folder'), parent.cwd, parentProject, worktree)

    const model = str(args, 'model')
    if (
      model &&
      agent.capabilities.models?.length &&
      !agent.capabilities.models.some((m) => m.id === model)
    )
      throw new Error(`${agent.label} has no model "${model}" (see list_agents)`)

    const { sessionId } = await this.host.create(
      {
        instanceId: agent.id,
        cwd: projectless ? undefined : folder,
        projectless: projectless || undefined,
        title: str(args, 'title')?.slice(0, 80),
        permissionMode,
        model,
        workspace: worktree ? { mode: 'worktree' } : undefined,
        agentTools: depth < MAX_DEPTH,
      },
      { parent: { sessionId: parentId, depth } },
    )
    await this.host.prompt(sessionId, str(args, 'prompt', true)!)
    const child = digest(this.host.readSession(sessionId))
    return {
      session_id: sessionId,
      agent: agent.id,
      mode: permissionMode ?? "the agent's default",
      folder: child?.cwd ?? folder,
      ...(child?.branch ? { branch: child.branch } : {}),
      next: 'Call wait_for with this session_id to get its answer.',
    }
  }

  /** A mode for the child that allows no more than the parent's does now. */
  private childMode(
    parentId: string,
    parent: SessionDigest,
    agent: ProviderInstance,
    requested: string | undefined,
  ): string | undefined {
    const parentModeId = this.host.currentMode(parentId)
    const parentModes = this.modesOf(parentId)
    const parentMode = parentModes.find((m) => m.id === parentModeId)
    const ceiling = modeLevel(parentMode ?? parentModeId ?? 'default')
    const modes = agent.capabilities.permissionModes
    if (requested) {
      const mode = modes.find((m) => m.id === requested)
      if (modes.length > 0 && !mode)
        throw new Error(`${agent.label} has no mode "${requested}" (see list_agents)`)
      if (modeLevel(mode ?? requested) > ceiling)
        throw new Error(
          `"${requested}" allows more than this session's own mode (${parentMode?.label ?? parentModeId ?? 'default'})`,
        )
      return requested
    }
    if (modes.length === 0) return undefined
    const allowed = modes.filter((m) => modeLevel(m) <= ceiling)
    const best = allowed.sort((a, b) => modeLevel(b) - modeLevel(a))[0]
    if (!best) {
      throw new Error(
        `${agent.label} has no mode as limited as this session's (${parent.title}); pick another agent`,
      )
    }
    return best.id
  }

  private modesOf(sessionId: string): PermissionModeOption[] {
    let modes: PermissionModeOption[] = []
    for (const { event } of this.host.readSession(sessionId)) {
      if (event.type === 'session.modes') modes = event.modes as PermissionModeOption[]
    }
    return modes
  }

  private async childFolder(
    requested: string | undefined,
    parentCwd: string,
    parentProject: string | undefined,
    worktree: boolean,
  ): Promise<string> {
    if (!requested) return worktree && parentProject ? parentProject : parentCwd
    const wanted = path.resolve(parentCwd, requested)
    const allowed = [parentCwd, parentProject, ...(await this.host.projectPaths())].filter(
      (p): p is string => Boolean(p),
    )
    const inside = allowed.some((root) => isInsideFolder(root, wanted))
    if (!inside)
      throw new Error(`${wanted} is not this session's folder or one of BeddCode's projects`)
    return wanted
  }

  private async wait(parentId: string, args: Args) {
    const first = this.child(parentId, args)
    const seconds = Math.min(
      Math.max(Number(args.timeout_seconds) || WAIT_DEFAULT_S, 1),
      WAIT_MAX_S,
    )
    const settled = (d: SessionDigest) =>
      (d.status === 'idle' || d.status === 'error' || d.status === 'cancelled') &&
      !this.host.isBusy(d.sessionId)
    const needsYou = (d: SessionDigest) => d.status === 'needs-you'
    const check = () => digest(this.host.readSession(first.sessionId)) ?? first
    let current = check()
    // A request waiting for the user is reported once; after that, wait_for waits for it to move on.
    const lastAsk = () =>
      this.host
        .readSession(first.sessionId)
        .findLast(
          (e) => e.event.type === 'approval.requested' || e.event.type === 'question.requested',
        )?.seq ?? 0
    const fresh = (d: SessionDigest) => needsYou(d) && this.reported.get(d.sessionId) !== lastAsk()
    if (!settled(current) && !fresh(current)) {
      current = await new Promise<SessionDigest>((resolve) => {
        const finish = () => {
          clearTimeout(timer)
          stop()
          resolve(check())
        }
        const timer = setTimeout(finish, seconds * 1000)
        const stop = this.host.subscribe((stored) => {
          if (stored.event.sessionId !== first.sessionId) return
          const t = stored.event.type
          const asks = t === 'approval.requested' || t === 'question.requested'
          if (t !== 'turn.completed' && !asks) return
          // Let the host finish its own bookkeeping for the event first.
          setTimeout(() => {
            const now = check()
            if (settled(now) || (asks && fresh(now))) finish()
          }, 50)
        })
      })
    }
    if (needsYou(current)) this.reported.set(current.sessionId, lastAsk())
    return {
      ...brief(current),
      done: settled(current),
      ...(current.status === 'running' ? { note: 'Still working; call wait_for again.' } : {}),
      reply: current.lastReply.slice(-8_000),
    }
  }
}

/**
 * Whether `target` is `root` or somewhere under it. Both are resolved first, so on Windows a
 * drive-less `/projects` and `D:\\projects` compare equal, and case and separators do not matter.
 */
export function isInsideFolder(root: string, target: string, p: path.PlatformPath = path): boolean {
  const rel = p.relative(p.resolve(root), p.resolve(target))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel))
}
