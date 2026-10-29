import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import type { Logger } from '@beddcode/shared'
import type { SessionManager } from '../sessions/sessionManager.ts'
import type { EventStore } from '../store/eventStore.ts'
import { digest } from '../automation/digest.ts'
import { modeLevel } from '../automation/agentTools.ts'
import { GitService } from '../workspace/git.ts'

export interface GatewayHostOptions {
  url: string
  secret: string
  projects(): Promise<string[]>
  home: string
  sessions: SessionManager
  store: EventStore
  log: Logger
  allowApprovals?(): boolean
  allowProjectRead?(): boolean
}

/** Only handles the gateway's narrow tool vocabulary, never generic host RPC. */
export class GatewayHost {
  private socket?: WebSocket
  private timer?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private pongTimeout?: ReturnType<typeof setTimeout>
  private stopped = false
  private attempts = 0
  private readonly ids: Set<string>
  private readonly file: string
  private running = 0
  private readonly git = new GitService()
  status: 'connecting' | 'online' | 'offline' | 'off' = 'off'
  error?: string

  constructor(private readonly options: GatewayHostOptions) {
    const url = new URL(options.url)
    if (
      url.protocol !== 'wss:' &&
      !(url.protocol === 'ws:' && ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname))
    )
      throw new Error('MCP gateway needs a secure wss URL')
    if (!options.secret) throw new Error('MCP gateway needs a host secret')
    this.file = path.join(options.home, 'mcp-gateway-sessions.json')
    try {
      const saved: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      this.ids = new Set(
        Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : [],
      )
    } catch {
      this.ids = new Set()
    }
  }

  start() {
    if (!this.stopped && this.socket) return
    this.stopped = false
    this.attempts = 0
    this.connect()
  }
  stop() {
    this.stopped = true
    this.status = 'off'
    this.error = undefined
    if (this.timer) clearTimeout(this.timer)
    this.timer = undefined
    this.clearHeartbeat()
    this.socket?.close()
    this.socket = undefined
  }

  private clearHeartbeat() {
    if (this.heartbeat) clearInterval(this.heartbeat)
    if (this.pongTimeout) clearTimeout(this.pongTimeout)
    this.heartbeat = undefined
    this.pongTimeout = undefined
  }

  private connect() {
    if (this.stopped) return
    this.status = 'connecting'
    this.error = undefined
    let connectedAt = 0
    let retryAfter = 0
    const ws = new WebSocket(this.options.url, {
      headers: { authorization: `Bearer ${this.options.secret}` },
      maxPayload: 65536,
      handshakeTimeout: 10000,
    })
    this.socket = ws
    ws.on('open', () => {
      if (this.socket !== ws || this.stopped) return
      this.status = 'online'
      this.error = undefined
      connectedAt = Date.now()
      this.heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return
        ws.ping()
        this.pongTimeout = setTimeout(() => {
          this.error = 'The Worker stopped responding. Reconnecting…'
          ws.terminate()
        }, 15000)
      }, 25000)
      this.options.log.info('MCP gateway connected')
    })
    ws.on('pong', () => {
      if (this.socket !== ws) return
      if (this.pongTimeout) clearTimeout(this.pongTimeout)
      this.pongTimeout = undefined
    })
    ws.on('unexpected-response', (_request, response) => {
      if (this.socket !== ws) return
      const code = response.statusCode
      if (code === 401 || code === 403) retryAfter = 120000
      if (code === 429) {
        const seconds = Number(response.headers['retry-after'])
        if (Number.isFinite(seconds) && seconds > 0) retryAfter = Math.min(seconds * 1000, 600000)
      }
      this.error =
        code === 401 || code === 403
          ? 'The Worker rejected the host secret. Check HOST_SECRET on the Worker and in these settings.'
          : code === 429
            ? 'The Worker is rate limiting connections. Wait before trying again.'
            : code === 503
              ? 'The Worker is not configured or is unavailable. Check its MCP_PASSWORD and HOST_SECRET.'
              : `The Worker rejected the connection (HTTP ${code ?? 'unknown'}).`
      response.resume()
      ws.terminate()
    })
    ws.on('error', (error) => {
      if (this.socket !== ws) return
      if (!this.error)
        this.error = /timed out/i.test(error.message)
          ? 'The connection timed out. Check the Worker address and network.'
          : 'Could not reach the Worker. Check the address and network.'
      this.options.log.warn('MCP gateway connection failed')
    })
    ws.on('close', (code, reason) => {
      if (this.socket !== ws) return
      this.socket = undefined
      this.clearHeartbeat()
      if (!this.stopped) {
        this.status = 'offline'
        if (code === 1000 && reason.toString() === 'replaced') {
          this.error =
            'Another BeddCode host connected to this Worker. Connect again here to use this host.'
          return
        }
        if (connectedAt && Date.now() - connectedAt >= 30000) this.attempts = 0
        const base = Math.min(5000 * 2 ** Math.min(this.attempts++, 4), 60000)
        const delay = Math.max(retryAfter, Math.round(base * (0.8 + Math.random() * 0.4)))
        if (!this.error) this.error = 'The connection was interrupted. Reconnecting…'
        this.timer = setTimeout(() => {
          this.timer = undefined
          this.connect()
        }, delay)
      }
    })
    ws.on('message', (raw) => {
      if (this.socket !== ws || this.stopped) return
      void this.receive(ws, String(raw))
    })
  }

  private async receive(ws: WebSocket, text: string) {
    let request: { id?: unknown; name?: unknown; args?: unknown }
    try {
      request = JSON.parse(text)
    } catch {
      return
    }
    if (typeof request.id !== 'string' || typeof request.name !== 'string') return
    const id = request.id
    if (this.running >= 10) return void ws.send(JSON.stringify({ id, error: 'Host is busy.' }))
    this.running++
    try {
      const args =
        request.args && typeof request.args === 'object' && !Array.isArray(request.args)
          ? (request.args as Record<string, unknown>)
          : {}
      const result = await this.call(request.name, args)
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id, result }))
    } catch (error) {
      if (ws.readyState === WebSocket.OPEN)
        ws.send(
          JSON.stringify({
            id,
            error: error instanceof Error ? error.message.slice(0, 1000) : 'Host request failed',
          }),
        )
    } finally {
      this.running--
    }
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const required = (key: string, max: number) => {
      const value = args[key]
      if (typeof value !== 'string' || !value.trim() || value.length > max)
        throw new Error(`Invalid ${key}`)
      return value
    }
    if (name === 'list_agents')
      return (await this.options.sessions.listProviders()).map((p) => ({
        id: p.id,
        label: p.label,
        status: p.status,
        models: p.capabilities.models,
        efforts: p.capabilities.efforts,
        modes: p.capabilities.permissionModes,
      }))
    if (name === 'list_projects') return { projects: await this.options.projects() }
    if (name === 'get_agent_options') {
      const agent = required('agent', 200)
      const provider = (await this.options.sessions.listProviders()).find((p) => p.id === agent)
      if (!provider) throw new Error('Agent is not available')
      let project: string | undefined
      if (args.project !== undefined) {
        const requested = required('project', 4096)
        project = (await this.options.projects()).find(
          (p) => path.resolve(p) === path.resolve(requested),
        )
        if (!project) throw new Error('Project is not added to this BeddCode host')
      }
      const preview = await this.options.sessions.previewAgent(agent, project)
      return {
        agent: provider.id,
        status: provider.status,
        models: provider.capabilities.models ?? [],
        efforts: provider.capabilities.efforts ?? [],
        ...preview,
      }
    }
    if (name === 'list_sessions') {
      const limit =
        typeof args.limit === 'number' && Number.isInteger(args.limit)
          ? Math.min(100, Math.max(1, args.limit))
          : 25
      if (
        args.cursor !== undefined &&
        (typeof args.cursor !== 'number' || !Number.isSafeInteger(args.cursor) || args.cursor < 1)
      )
        throw new Error('Invalid session cursor')
      const ids = this.options.store.listSessionIds(args.cursor as number | undefined, limit + 1)
      const items = ids.slice(0, limit).flatMap(({ id }) => {
        const events = this.options.store.readSession(id)
        const state = digest(events)
        return state
          ? [{ ...state, lastReply: undefined, updated_at: events.at(-1)?.event.at }]
          : []
      })
      return { sessions: items, next_cursor: ids.length > limit ? ids[limit - 1]?.latest : null }
    }
    if (name === 'project_status' || name === 'project_diff' || name === 'read_project_file') {
      if (this.options.allowProjectRead?.() === false)
        throw new Error('Project reading is disabled in BeddCode settings')
      const requested = required('project', 4096)
      const project = (await this.options.projects()).find(
        (p) => path.resolve(p) === path.resolve(requested),
      )
      if (!project) throw new Error('Project is not added to this BeddCode host')
      if (name === 'project_status') {
        const status = await this.git.status(project)
        const info = await this.git.info(project)
        if (!info.root) throw new Error('Project is not a Git repository')
        const projectRoot = await realpath(project)
        const repoRoot = await realpath(info.root)
        const withinProject = (file: string) => {
          const relative = path.relative(projectRoot, path.resolve(repoRoot, file))
          return relative &&
            relative !== '..' &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative)
            ? relative.replace(/\\/g, '/')
            : undefined
        }
        status.files = status.files.flatMap((file) => {
          const filePath = withinProject(file.path)
          if (!filePath) return []
          const oldPath = file.oldPath ? withinProject(file.oldPath) : undefined
          return [{ ...file, path: filePath, oldPath }]
        })
        if (Buffer.byteLength(JSON.stringify(status)) > 180000)
          throw new Error('Project status is too large to return')
        return status
      }
      const relative = required('path', 4096)
      if (path.isAbsolute(relative)) throw new Error('File path must be relative to the project')
      const root = await realpath(project)
      const target = path.resolve(root, relative)
      let resolved: string
      try {
        resolved = await realpath(target)
      } catch {
        if (name !== 'project_diff') throw new Error('File not found')
        const parent = await realpath(path.dirname(target)).catch(() => {
          throw new Error('File not found')
        })
        resolved = path.join(parent, path.basename(target))
      }
      const inside = path.relative(root, resolved)
      if (
        !inside ||
        inside === '..' ||
        inside.startsWith(`..${path.sep}`) ||
        path.isAbsolute(inside)
      )
        throw new Error('File is outside the selected project')
      if (name === 'project_diff') {
        const info = await this.git.info(root)
        if (!info.root) throw new Error('Project is not a Git repository')
        const repoRoot = await realpath(info.root)
        const diff = await this.git.diff(repoRoot, path.relative(repoRoot, resolved))
        diff.path = inside.replace(/\\/g, '/')
        if (Buffer.byteLength(JSON.stringify(diff)) > 180000)
          throw new Error('Diff is too large to return; choose a smaller file')
        return diff
      }
      const file = await open(resolved, 'r')
      try {
        const info = await file.stat()
        if (!info.isFile() || info.size > 180000)
          throw new Error('File is not a regular file or exceeds 180 KB')
        const buffer = Buffer.alloc(180001)
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
        const data = buffer.subarray(0, bytesRead)
        if (data.length > 180000 || data.includes(0))
          throw new Error('File is binary or exceeds 180 KB')
        return { path: inside, content: data.toString('utf8') }
      } finally {
        await file.close()
      }
    }
    if (name === 'start_session') {
      const agent = required('agent', 200)
      const prompt = required('prompt', 30000)
      const requestedProject = required('project', 4096)
      const projects = await this.options.projects()
      const project = projects.find((p) => path.resolve(p) === path.resolve(requestedProject))
      if (!project) throw new Error('Project is not added to this BeddCode host')
      const provider = (await this.options.sessions.listProviders()).find(
        (p) => p.id === agent && p.status === 'ready',
      )
      if (!provider) throw new Error('Agent is not available')
      let preview: Awaited<ReturnType<SessionManager['previewAgent']>> | undefined
      const getPreview = async () =>
        (preview ??= await this.options.sessions.previewAgent(agent, project))
      let modes = provider.capabilities.permissionModes
      const requestedMode = args.mode === undefined ? undefined : required('mode', 200)
      if (
        (!modes.length || (requestedMode && !modes.some((m) => m.id === requestedMode))) &&
        provider.kind === 'acp'
      )
        modes = (await getPreview()).modes
      const mode = requestedMode
        ? modes.find((m) => m.id === requestedMode)
        : modes.find((m) => modeLevel(m) <= 1)
      if (!mode) throw new Error('Agent does not advertise an asking or read-only permission mode')
      if (modeLevel(mode) > 1)
        throw new Error('Remote sessions require an asking or read-only mode')
      const model = args.model === undefined ? undefined : required('model', 200)
      const effort = args.effort === undefined ? undefined : required('effort', 200)
      let config: Record<string, string | boolean> | undefined
      if (args.config !== undefined) {
        if (
          !args.config ||
          typeof args.config !== 'object' ||
          Array.isArray(args.config) ||
          Object.keys(args.config).length > 30 ||
          !Object.entries(args.config).every(
            ([key, value]) =>
              key.length > 0 &&
              key.length <= 200 &&
              (typeof value === 'boolean' || (typeof value === 'string' && value.length <= 1000)),
          )
        )
          throw new Error('Invalid agent settings')
        const offered = await getPreview()
        for (const [id, value] of Object.entries(args.config)) {
          const option = offered.config.find((o) => o.id === id)
          if (
            !option ||
            option.category === 'mode' ||
            /permission|approval|sandbox/i.test(`${option.id} ${option.category ?? ''}`)
          )
            throw new Error(`Agent setting ${id} is unavailable or controlled by the session mode`)
          if (
            (option.type === 'boolean' && typeof value !== 'boolean') ||
            (option.type === 'select' &&
              (typeof value !== 'string' ||
                !option.choices?.some((choice) => choice.value === value)))
          )
            throw new Error(`Invalid value for agent setting ${id}`)
        }
        config = args.config as Record<string, string | boolean>
      }
      if (provider.kind === 'acp' && (model || effort)) {
        const offered = await getPreview()
        const modelOption = offered.config.find(
          (o) => o.type === 'select' && o.category === 'model',
        )
        const effortOption = offered.config.find(
          (o) =>
            o.type === 'select' &&
            (o.category === 'thought_level' ||
              /^(reasoning[_-]effort|thinking[_-]level|thought[_-]level)$/i.test(o.id)),
        )
        if (
          model &&
          (!modelOption || !modelOption.choices?.some((choice) => choice.value === model))
        )
          throw new Error('Model is not offered by this agent; check get_agent_options')
        if (
          effort &&
          (!effortOption || !effortOption.choices?.some((choice) => choice.value === effort))
        )
          throw new Error('Effort is not offered by this agent; check get_agent_options')
        config = {
          ...config,
          ...(model && modelOption ? { [modelOption.id]: model } : {}),
          ...(effort && effortOption ? { [effortOption.id]: effort } : {}),
        }
      } else {
        if (
          model &&
          provider.capabilities.models?.length &&
          !provider.capabilities.models.some((option) => option.id === model)
        )
          throw new Error('Model is not offered by this agent')
        const levels =
          provider.capabilities.models?.find((option) => option.id === model)?.efforts ??
          provider.capabilities.efforts
        if (effort && levels?.length && !levels.includes(effort))
          throw new Error('Effort is not offered for this model')
      }
      const created = await this.options.sessions.create(
        {
          instanceId: agent,
          cwd: project,
          title: 'MCP: ' + prompt.slice(0, 70),
          permissionMode: mode.id,
          model,
          effort,
          config,
          workspace: args.worktree === true ? { mode: 'worktree' } : undefined,
        },
        { mcpGateway: true },
      )
      this.ids.add(created.sessionId)
      mkdirSync(this.options.home, { recursive: true })
      try {
        writeFileSync(this.file, JSON.stringify([...this.ids]), { mode: 0o600 })
      } catch {
        throw new Error(
          `Session ${created.sessionId} was created but could not be recorded. Check BeddCode before retrying.`,
        )
      }
      try {
        await this.options.sessions.prompt(created.sessionId, prompt)
      } catch (error) {
        throw new Error(
          `Session ${created.sessionId} was created but its prompt could not be sent. Check BeddCode before retrying. ${error instanceof Error ? error.message : ''}`.trim(),
        )
      }
      return { session_id: created.sessionId }
    }
    const sessionId = required('session_id', 200)
    const sessionEvents = this.options.store.readSession(sessionId)
    if (
      !sessionEvents.some(({ event }) => event.type === 'session.created') &&
      !this.ids.has(sessionId)
    )
      throw new Error('Session not found')
    if (
      name === 'get_session_options' ||
      name === 'set_session_model' ||
      name === 'set_session_config' ||
      name === 'set_session_mode'
    ) {
      const created = sessionEvents.find(({ event }) => event.type === 'session.created')?.event
      if (!created || created.type !== 'session.created')
        throw new Error('Session details are unavailable')
      const provider = (await this.options.sessions.listProviders()).find(
        (p) => p.id === created.instanceId,
      )
      if (!provider) throw new Error('Session agent is not available')
      const latestConfig = sessionEvents.findLast(
        ({ event }) => event.type === 'session.config',
      )?.event
      const options = latestConfig?.type === 'session.config' ? latestConfig.options : []
      const latestModes = sessionEvents.findLast(
        ({ event }) => event.type === 'session.modes',
      )?.event
      const latestCommands = sessionEvents.findLast(
        ({ event }) => event.type === 'session.commands',
      )?.event
      const modes =
        latestModes?.type === 'session.modes'
          ? latestModes.modes
          : provider.capabilities.permissionModes
      const modelEvent = sessionEvents.findLast(
        ({ event }) => event.type === 'session.model',
      )?.event
      const configuredModel = options.find((o) => o.category === 'model' && o.type === 'select')
      const configuredEffort = options.find(
        (o) =>
          o.type === 'select' &&
          (o.category === 'thought_level' ||
            /^(reasoning[_-]effort|thinking[_-]level|thought[_-]level)$/i.test(o.id)),
      )
      const model =
        typeof configuredModel?.value === 'string'
          ? configuredModel.value
          : modelEvent?.type === 'session.model'
            ? modelEvent.model
            : created.model
      const effort =
        typeof configuredEffort?.value === 'string'
          ? configuredEffort.value
          : modelEvent?.type === 'session.model'
            ? modelEvent.effort
            : created.effort
      if (name === 'get_session_options')
        return {
          agent: created.instanceId,
          model,
          effort,
          models: provider.capabilities.models ?? [],
          efforts: provider.capabilities.efforts ?? [],
          modes,
          current_mode:
            latestModes?.type === 'session.modes'
              ? latestModes.currentModeId
              : created.permissionMode,
          config: options,
          commands: latestCommands?.type === 'session.commands' ? latestCommands.commands : [],
        }
      if (name === 'set_session_mode') {
        const modeId = required('mode', 200)
        const mode = modes.find((m) => m.id === modeId)
        if (!mode) throw new Error('Mode is not advertised by this session')
        if (modeLevel(mode) > 1)
          throw new Error('Remote sessions require an asking or read-only mode')
        await this.options.sessions.setMode(sessionId, modeId)
        return { accepted: true, mode: modeId }
      }
      if (name === 'set_session_config') {
        const id = required('option_id', 200)
        const option = options.find((o) => o.id === id)
        if (
          !option ||
          option.category === 'mode' ||
          /permission|approval|sandbox/i.test(`${option.id} ${option.category ?? ''}`)
        )
          throw new Error('Setting is unavailable or controlled by the session mode')
        if (
          (option.type === 'boolean' && typeof args.value !== 'boolean') ||
          (option.type === 'select' &&
            (typeof args.value !== 'string' ||
              !option.choices?.some((c) => c.value === args.value)))
        )
          throw new Error('Value is not offered by this agent')
        await this.options.sessions.setConfig(sessionId, id, args.value as string | boolean)
        return { accepted: true }
      }
      const selectedModel = args.model === undefined ? undefined : required('model', 200)
      const selectedEffort = args.effort === undefined ? undefined : required('effort', 200)
      if (selectedModel === undefined && selectedEffort === undefined)
        throw new Error('Provide a model or effort')
      const modelOption = options.find((o) => o.category === 'model' && o.type === 'select')
      const effortOption = options.find(
        (o) =>
          o.type === 'select' &&
          (o.category === 'thought_level' ||
            /^(reasoning[_-]effort|thinking[_-]level|thought[_-]level)$/i.test(o.id)),
      )
      if ((selectedModel && modelOption) || (selectedEffort && effortOption)) {
        if (
          selectedModel &&
          (!modelOption || !modelOption.choices?.some((c) => c.value === selectedModel))
        )
          throw new Error('Model is not offered by this agent')
        if (
          selectedEffort &&
          (!effortOption || !effortOption.choices?.some((c) => c.value === selectedEffort))
        )
          throw new Error('Effort is not offered by this agent')
        if (selectedModel && modelOption)
          await this.options.sessions.setConfig(sessionId, modelOption.id, selectedModel)
        if (selectedEffort && effortOption) {
          try {
            await this.options.sessions.setConfig(sessionId, effortOption.id, selectedEffort)
          } catch (err) {
            if (selectedModel)
              throw new Error(
                `Model changed, but effort could not be changed: ${err instanceof Error ? err.message : String(err)}`,
              )
            throw err
          }
        }
      } else {
        const targetModel = selectedModel ?? model
        if (selectedModel && !provider.capabilities.models?.some((m) => m.id === selectedModel))
          throw new Error('Model is not offered by this agent')
        const levels =
          provider.capabilities.models?.find((m) => m.id === targetModel)?.efforts ??
          provider.capabilities.efforts
        if (selectedEffort && !levels?.includes(selectedEffort))
          throw new Error('Effort is not offered for this model')
        await this.options.sessions.setModel(
          sessionId,
          targetModel,
          selectedEffort ?? (selectedModel ? undefined : effort),
        )
      }
      return { accepted: true }
    }
    if (name === 'rename_session') {
      const title = required('title', 120).trim()
      this.options.sessions.rename(sessionId, title)
      return { accepted: true }
    }
    if (name === 'set_session_done') {
      if (typeof args.done !== 'boolean') throw new Error('done must be true or false')
      this.options.sessions.setDone(sessionId, args.done)
      return { accepted: true }
    }
    if (name === 'get_session_events') {
      if (
        args.cursor !== undefined &&
        (typeof args.cursor !== 'number' || !Number.isSafeInteger(args.cursor) || args.cursor < 0)
      )
        throw new Error('Invalid event cursor')
      const after =
        typeof args.cursor === 'number' && Number.isSafeInteger(args.cursor) && args.cursor >= 0
          ? args.cursor
          : 0
      const limit =
        typeof args.limit === 'number' && Number.isInteger(args.limit)
          ? Math.min(100, Math.max(1, args.limit))
          : 25
      const selected = sessionEvents.filter(({ seq }) => seq > after)
      const events: typeof sessionEvents = []
      let bytes = 0
      for (const entry of selected) {
        const size = Buffer.byteLength(JSON.stringify(entry))
        if (size > 180000) throw new Error(`Session event ${entry.seq} exceeds the response limit`)
        if (events.length >= limit || bytes + size > 180000) break
        events.push(entry)
        bytes += size
      }
      return {
        events,
        next_cursor: events.at(-1)?.seq ?? after,
        has_more: events.length < selected.length,
      }
    }
    if (
      name === 'get_pending_requests' ||
      name === 'answer_question' ||
      name === 'resolve_approval'
    ) {
      const pending = new Map<string, (typeof sessionEvents)[number]['event']>()
      for (const { event } of sessionEvents) {
        if (event.type === 'approval.requested' || event.type === 'question.requested')
          pending.set(event.requestId, event)
        if (event.type === 'approval.resolved' || event.type === 'question.resolved')
          pending.delete(event.requestId)
        if (event.type === 'turn.completed') pending.clear()
      }
      if (name === 'get_pending_requests') return { requests: [...pending.values()] }
      const requestId = required('request_id', 200)
      const request = pending.get(requestId)
      if (name === 'answer_question') {
        if (request?.type !== 'question.requested') throw new Error('Question is no longer pending')
        if (
          !args.answers ||
          typeof args.answers !== 'object' ||
          Array.isArray(args.answers) ||
          !Object.values(args.answers).every(
            (v) => Array.isArray(v) && v.every((s) => typeof s === 'string'),
          )
        )
          throw new Error('answers must map question IDs to arrays of strings')
        const answers = args.answers as Record<string, string[]>
        if (Object.keys(answers).some((id) => !request.questions.some((q) => q.id === id)))
          throw new Error('Unknown question ID')
        for (const question of request.questions) {
          const values = answers[question.id]
          if (
            !values?.length ||
            (!question.multiSelect && values.length > 1) ||
            values.some((value) => !value.trim() || value.length > 30000)
          )
            throw new Error('Invalid question answer')
          if (
            question.options &&
            !question.allowOther &&
            values.some((value) => !question.options!.some((option) => option.label === value))
          )
            throw new Error('Answer is not an available choice')
        }
        await this.options.sessions.answerQuestion(
          sessionId,
          requestId,
          args.answers as Record<string, string[]>,
        )
      } else {
        if (this.options.allowApprovals?.() === false)
          throw new Error('Remote approval decisions are disabled in BeddCode settings')
        if (request?.type !== 'approval.requested') throw new Error('Approval is no longer pending')
        const optionId = required('option_id', 200)
        if (
          !request.options.some(
            (option) =>
              option.id === optionId &&
              (option.kind === 'allow' || option.kind === 'deny') &&
              !/always|permanent|all future|for (the )?session/i.test(
                `${option.id} ${option.label}`,
              ),
          )
        )
          throw new Error('Invalid or persistent approval choice; choose a single-request option')
        await this.options.sessions.approve(sessionId, requestId, optionId)
      }
      return { accepted: true }
    }
    if (name === 'get_session') {
      const state = digest(sessionEvents)
      if (!state) throw new Error('Session not found')
      return {
        session_id: sessionId,
        status: state.status,
        latest_reply: state.lastReply.slice(-24000),
        waiting_on: state.waitingOn,
        error: state.lastError,
      }
    }
    if (name === 'send_message')
      return this.options.sessions.prompt(sessionId, required('text', 30000))
    if (name === 'stop_session') {
      await this.options.sessions.interrupt(sessionId)
      return { stopped: true }
    }
    throw new Error('Unknown tool')
  }
}
