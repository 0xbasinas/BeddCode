// The agent supervisor: a small detached process that owns agent CLIs (their stdio pipes) so they
// outlive the host. Plain Node, no dependencies, so it starts with `node daemon.mjs --dir <dir>`.
// See docs/agent-supervisor.md for the design and the wire protocol.
import net from 'node:net'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

const isWindows = process.platform === 'win32'
const argv = process.argv.slice(2)
const dir = path.resolve(argv[argv.indexOf('--dir') + 1] ?? '.')
// Agents with no host attached are ended after a while, so a host that never comes back leaks
// nothing. One in the middle of a turn is worth waiting for much longer than one that is idle
// (a host that restarts later still resumes an idle conversation from the agent's own history).
const IDLE_GRACE_MS = Number(
  process.env.BEDDCODE_SUPERVISOR_IDLE_GRACE_MS ??
    process.env.BEDDCODE_SUPERVISOR_GRACE_MS ??
    10 * 60_000,
)
const ACTIVE_GRACE_MS = Number(
  process.env.BEDDCODE_SUPERVISOR_ACTIVE_GRACE_MS ??
    process.env.BEDDCODE_SUPERVISOR_GRACE_MS ??
    60 * 60_000,
)
const graceFor = (agent) =>
  agent.meta?.active === true && !agent.turnOver ? ACTIVE_GRACE_MS : IDLE_GRACE_MS
// The daemon itself leaves when it has held no agent and no connection for this long.
const IDLE_MS = Number(process.env.BEDDCODE_SUPERVISOR_IDLE_MS ?? 60_000)
const REPLAY_SLICE = 256 * 1024
// What the log may hold of output the host already took in before it is cut back to what is needed.
const COMPACT_AT = 4 * 1024 * 1024

fs.mkdirSync(path.join(dir, 'logs'), { recursive: true })
const infoFile = path.join(dir, 'supervisor.json')
const token = crypto.randomBytes(24).toString('hex')
const endpoint = isWindows
  ? `\\\\.\\pipe\\beddcode-sup-${crypto.createHash('sha1').update(dir.toLowerCase()).digest('hex').slice(0, 16)}`
  : path.join(dir, 'supervisor.sock')

/** @type {Map<string, Agent>} */
const agents = new Map()
let connections = 0
let idleSince = Date.now()

/**
 * @typedef {object} Agent
 * @property {string} id
 * @property {import('node:child_process').ChildProcess} child
 * @property {string} log        file holding everything the agent wrote to stdout
 * @property {number} base       offset of the first byte still in that file (the rest was taken in)
 * @property {number} size       offset just past the last byte written (absolute, like `base`)
 * @property {number} acked      bytes the host has taken in (always the end of a whole line)
 * @property {{ code: number | null, signal: string | null } | null} exited
 * @property {net.Socket | null} conn
 * @property {number} attaches
 * @property {number} detachedAt
 * @property {unknown} meta      opaque state the host keeps with the agent
 * @property {Map<string, { line: string, off: number }>} asks  requests the agent made that nobody answered
 * @property {string | null} initId
 * @property {object | null} initResponse
 * @property {boolean} [turnOver]  the agent's turn ended while no host was attached
 * @property {'claude' | 'jsonrpc'} protocol
 * @property {string[][]} memo        request methods answered again from the first answer, by group
 * @property {Set<string>} swallow    notifications a reattached host sends that are dropped
 * @property {Map<string, number>} memoPending  ids of requests whose answer is to be remembered
 * @property {Map<number, object>} memoCache    the remembered answers, by group
 */

function send(sock, frame) {
  if (sock && !sock.destroyed) sock.write(JSON.stringify(frame) + '\n')
}

function killTree(agent) {
  const child = agent.child
  if (agent.exited || child.pid === undefined) return
  try {
    child.stdin.end()
  } catch {}
  const hard = () => {
    if (agent.exited) return
    if (isWindows) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      }).on('error', () => {})
    } else {
      try {
        child.kill('SIGKILL')
      } catch {}
    }
  }
  // Closing stdin is the polite request; most agents exit on it. Then a signal, then the tree.
  if (!isWindows)
    setTimeout(() => {
      if (!agent.exited)
        try {
          child.kill('SIGTERM')
        } catch {}
    }, 1_000).unref()
  setTimeout(hard, 3_000).unref()
}

function dropAgent(agent) {
  agents.delete(agent.id)
  for (const f of [agent.log]) fs.rm(f, { force: true }, () => {})
}

function spawnAgent(id, spec) {
  const { command, args = [], cwd, env, meta } = spec
  const old = agents.get(id)
  if (old) {
    if (!old.exited) throw new Error(`Agent ${id} is already running; attach to it instead`)
    old.conn?.end()
    dropAgent(old)
  }
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  })
  /** @type {Agent} */
  const agent = {
    id,
    child,
    log: path.join(dir, 'logs', `${crypto.randomBytes(6).toString('hex')}.out`),
    base: 0,
    size: 0,
    acked: 0,
    exited: null,
    conn: null,
    attaches: 1,
    detachedAt: Date.now(),
    meta,
    asks: new Map(),
    initId: null,
    initResponse: null,
    protocol: spec.protocol === 'jsonrpc' ? 'jsonrpc' : 'claude',
    memo: spec.handshake?.memo ?? [],
    swallow: new Set(spec.handshake?.swallow ?? []),
    memoPending: new Map(),
    memoCache: new Map(),
  }
  agents.set(id, agent)
  fs.writeFileSync(agent.log, '')

  const decoder = new StringDecoder('utf8')
  let partial = ''
  let partialOff = 0
  child.stdout.on('data', (buf) => {
    const text = decoder.write(buf)
    if (!text) return
    const off = agent.size
    fs.appendFileSync(agent.log, text)
    agent.size += Buffer.byteLength(text)
    send(agent.conn, { op: 'out', off, data: text })
    // Look at whole lines to know what the agent is waiting for (see `inspectOut`).
    let rest = partial + text
    let lineOff = partialOff
    for (let nl = rest.indexOf('\n'); nl !== -1; nl = rest.indexOf('\n')) {
      inspectOut(agent, rest.slice(0, nl), lineOff)
      lineOff += Buffer.byteLength(rest.slice(0, nl + 1))
      rest = rest.slice(nl + 1)
    }
    partial = rest
    partialOff = lineOff
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (text) => send(agent.conn, { op: 'err', data: text }))
  child.stdin.on('error', () => {})
  child.on('error', (err) => {
    agent.exited ??= { code: null, signal: null }
    send(agent.conn, { op: 'exit', code: null, signal: null, error: String(err.message ?? err) })
  })
  // 'close' comes after stdout ended, so the host has seen everything before it hears of the exit.
  child.on('close', (code, signal) => {
    agent.exited = { code, signal }
    send(agent.conn, { op: 'exit', code, signal })
    agent.detachedAt = agent.conn ? 0 : Date.now()
  })
  return agent
}

const isResponse = (m) => m && m.id !== undefined && m.method === undefined
const isRequest = (m) => m && m.id !== undefined && m.method !== undefined
const keyOf = (id) => JSON.stringify(id)
const groupOf = (agent, method) => agent.memo.findIndex((g) => g.includes(method))

/** Tracks the agent's own requests (a permission prompt, say) until the host answers them. */
function inspectOut(agent, line, off) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  // A turn that ends while no host is attached: from then on the agent is idle, and waits less.
  const ended =
    agent.protocol === 'jsonrpc'
      ? msg?.method === 'turn/completed' ||
        msg?.type === 'agent_end' ||
        (isResponse(msg) && typeof msg.result?.stopReason === 'string')
      : msg?.type === 'result'
  if (ended && !agent.conn && agent.meta?.active === true) {
    agent.turnOver = true
    agent.detachedAt = Date.now()
  }
  if (agent.protocol === 'jsonrpc') {
    if (isRequest(msg)) agent.asks.set(keyOf(msg.id), { line, off })
    else if (isResponse(msg)) {
      const group = agent.memoPending.get(keyOf(msg.id))
      if (group !== undefined) {
        agent.memoPending.delete(keyOf(msg.id))
        if (msg.error === undefined && !agent.memoCache.has(group)) agent.memoCache.set(group, msg)
      }
    }
    return
  }
  if (msg?.type === 'control_request' && typeof msg.request_id === 'string') {
    agent.asks.set(msg.request_id, { line, off })
  } else if (msg?.type === 'control_cancel_request' && typeof msg.request_id === 'string') {
    agent.asks.delete(msg.request_id)
  } else if (
    msg?.type === 'control_response' &&
    agent.initId &&
    msg.response?.request_id === agent.initId &&
    msg.response?.subtype === 'success'
  ) {
    agent.initResponse = msg
  }
}

/**
 * Lines the host writes to the agent. A host that reattaches starts a new SDK query, which says
 * "initialize" again; the agent already did that, so it is answered from the first answer.
 */
function handleIn(agent, data, sock) {
  agent.inBuf = (agent.inBuf ?? '') + data
  let forward = ''
  for (let nl = agent.inBuf.indexOf('\n'); nl !== -1; nl = agent.inBuf.indexOf('\n')) {
    const line = agent.inBuf.slice(0, nl + 1)
    agent.inBuf = agent.inBuf.slice(nl + 1)
    let msg
    try {
      msg = JSON.parse(line)
    } catch {
      forward += line
      continue
    }
    if (agent.protocol === 'jsonrpc') {
      if (isRequest(msg)) {
        const group = groupOf(agent, msg.method)
        if (group >= 0) {
          const cached = agent.memoCache.get(group)
          if (agent.attaches > 1 && cached) {
            // The agent already did this for the previous host: answer from what it said then.
            send(sock, {
              op: 'out',
              off: -1,
              data: JSON.stringify({ ...cached, id: msg.id }) + '\n',
            })
            continue
          }
          if (!cached) agent.memoPending.set(keyOf(msg.id), group)
        }
      } else if (isResponse(msg)) {
        agent.asks.delete(keyOf(msg.id))
      } else if (msg?.method !== undefined && agent.attaches > 1 && agent.swallow.has(msg.method)) {
        continue
      }
      forward += line
      continue
    }
    if (msg?.type === 'control_request' && msg.request?.subtype === 'initialize') {
      if (agent.attaches > 1 && agent.initResponse) {
        const answer = structuredClone(agent.initResponse)
        answer.response.request_id = msg.request_id
        send(sock, { op: 'out', off: -1, data: JSON.stringify(answer) + '\n' })
        continue
      }
      agent.initId = msg.request_id
    } else if (msg?.type === 'control_response') {
      agent.asks.delete(msg.response?.request_id)
    }
    forward += line
  }
  if (forward && !agent.exited) agent.child.stdin.write(forward)
}

/** Drops the start of the log that the host has taken in, once that is a lot of it. */
function compact(agent) {
  if (agent.acked - agent.base < COMPACT_AT) return
  try {
    const keep = Buffer.alloc(agent.size - agent.acked)
    const fd = fs.openSync(agent.log, 'r')
    try {
      fs.readSync(fd, keep, 0, keep.length, agent.acked - agent.base)
    } finally {
      fs.closeSync(fd)
    }
    // Appends from the agent are synchronous on this thread, so nothing lands in between.
    fs.writeFileSync(agent.log, keep)
    agent.base = agent.acked
  } catch {}
}

function replay(agent, sock) {
  // Requests the agent is still waiting on come first, unless the log replay already holds them.
  for (const ask of agent.asks.values()) {
    if (ask.off < agent.acked) send(sock, { op: 'out', off: -1, data: ask.line + '\n' })
  }
  if (agent.size > agent.acked) {
    const fd = fs.openSync(agent.log, 'r')
    try {
      // In slices that end at a newline (a byte that never occurs inside a UTF-8 character), so
      // no character is cut and the host's acknowledgements stay at line ends.
      let off = agent.acked
      const buf = Buffer.alloc(REPLAY_SLICE)
      let carry = Buffer.alloc(0)
      while (off + carry.length < agent.size) {
        const at = off + carry.length
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, agent.size - at), at - agent.base)
        if (n === 0) break
        const chunk = Buffer.concat([carry, buf.subarray(0, n)])
        const end = chunk.lastIndexOf(0x0a) + 1
        const last = at + n >= agent.size
        const upto = last ? chunk.length : end
        if (upto === 0) {
          carry = chunk
          continue
        }
        const text = chunk.subarray(0, upto).toString('utf8')
        send(sock, { op: 'out', off, data: text })
        off += upto
        carry = chunk.subarray(upto)
      }
    } finally {
      fs.closeSync(fd)
    }
  }
  if (agent.exited) send(sock, { op: 'exit', ...agent.exited })
}

const describe = (a) => ({
  id: a.id,
  pid: a.child.pid,
  alive: !a.exited,
  size: a.size,
  acked: a.acked,
  attached: !!a.conn,
  meta: a.meta,
})

const server = net.createServer((sock) => {
  connections++
  idleSince = 0
  sock.setEncoding('utf8')
  let authed = false
  let buf = ''
  /** @type {Agent | null} */
  let mine = null
  sock.on('error', () => {})
  sock.on('close', () => {
    connections--
    if (mine && mine.conn === sock) {
      mine.conn = null
      mine.detachedAt = Date.now()
    }
    if (connections === 0 && agents.size === 0) idleSince = Date.now()
  })
  sock.on('data', (chunk) => {
    buf += chunk
    for (let nl = buf.indexOf('\n'); nl !== -1; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (!authed) {
        if (msg.op !== 'hello' || msg.token !== token) return sock.destroy()
        authed = true
        send(sock, { op: 'hello', version: 2, pid: process.pid })
        continue
      }
      try {
        handle(msg)
      } catch (err) {
        send(sock, { op: 'error', id: msg.id, message: String(err?.message ?? err) })
      }
    }
  })

  function claim(agent) {
    if (agent.conn && agent.conn !== sock) {
      send(agent.conn, { op: 'detached' })
      agent.conn.end()
    }
    agent.conn = sock
    mine = agent
  }

  function handle(msg) {
    // A superseded connection may still have buffered frames while its socket closes.
    // Only its current owner may write to or manage the agent.
    if (['in', 'ack', 'meta', 'close-stdin', 'kill', 'release'].includes(msg.op) &&
        (!mine || mine.conn !== sock || agents.get(mine.id) !== mine)) return
    switch (msg.op) {
      case 'list':
        return send(sock, { op: 'agents', agents: [...agents.values()].map(describe) })
      case 'spawn': {
        const agent = spawnAgent(msg.id, msg)
        claim(agent)
        return send(sock, { op: 'spawned', id: msg.id, pid: agent.child.pid })
      }
      case 'attach': {
        const agent = agents.get(msg.id)
        if (!agent) return send(sock, { op: 'error', id: msg.id, code: 'unknown' })
        claim(agent)
        agent.attaches++
        agent.turnOver = false
        agent.inBuf = ''
        send(sock, {
          op: 'attached',
          id: agent.id,
          pid: agent.child.pid,
          alive: !agent.exited,
          meta: agent.meta,
        })
        return replay(agent, sock)
      }
      case 'in':
        if (mine) handleIn(mine, msg.data, sock)
        return
      case 'ack':
        if (mine && Number.isFinite(msg.off) && msg.off > mine.acked && msg.off <= mine.size) {
          mine.acked = msg.off
          compact(mine)
        }
        return
      case 'meta':
        if (mine) {
          mine.meta = msg.meta
          mine.turnOver = false
        }
        return
      case 'close-stdin':
        try {
          mine?.child.stdin.end()
        } catch {}
        return
      case 'kill':
        if (mine) killTree(mine)
        return
      case 'release':
        // The host knows the agent ended; nothing is kept for it.
        if (mine?.exited) dropAgent(mine)
        return
    }
  }
})

setInterval(() => {
  const now = Date.now()
  for (const agent of agents.values()) {
    // An agent whose turn ended while no host was there gets the idle allowance from that moment.
    if (agent.conn || !agent.detachedAt || now - agent.detachedAt < graceFor(agent)) continue
    if (agent.exited) dropAgent(agent)
    else {
      console.log(
        `ending ${agent.id}: no host came back in ${Math.round(graceFor(agent) / 60_000)} min`,
      )
      killTree(agent)
    }
  }
  if (agents.size === 0 && connections === 0) {
    idleSince ||= now
    if (now - idleSince > IDLE_MS) shutdown()
  } else idleSince = 0
}, 500).unref()

function shutdown() {
  try {
    fs.rmSync(infoFile, { force: true })
    if (!isWindows) fs.rmSync(endpoint, { force: true })
  } catch {}
  process.exit(0)
}

// Only one daemon per folder: whoever manages to listen is it, the others leave. A socket file
// nobody listens on any more (a daemon that was killed) is removed and listened on again.
let retried = false
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !isWindows && !retried) {
    retried = true
    const probe = net.connect(endpoint)
    probe.once('connect', () => process.exit(0)) // a live daemon has it
    probe.once('error', () => {
      fs.rmSync(endpoint, { force: true })
      listen()
    })
    return
  }
  process.exit(err.code === 'EADDRINUSE' ? 0 : 1)
})
function listen() {
  server.listen(endpoint, () => {
    fs.writeFileSync(infoFile, JSON.stringify({ pid: process.pid, endpoint, token }), {
      mode: 0o600,
    })
    idleSince = Date.now()
  })
}
listen()
process.on('SIGTERM', shutdown)
