// A stand-in for agent CLIs that talk JSON lines over stdio, for the supervisor tests. FAKE_FLAVOR
// picks the dialect: `codex` (app-server JSON-RPC), `acp` (Agent Client Protocol) or `pi` (Pi RPC).
// For a prompt it "works" for a while, one message per tick, then ends the turn. With FAKE_ASK=1 it
// first asks the host for permission and waits for the answer, as the real agents do.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const flavor = process.env.FAKE_FLAVOR ?? 'codex'
const state = process.env.FAKE_STATE
const parts = Number(process.env.FAKE_PARTS ?? 8)
const tick = Number(process.env.FAKE_TICK_MS ?? 250)
const ask = !!process.env.FAKE_ASK
if (state) {
  fs.writeFileSync(path.join(state, 'pid'), String(process.pid))
  fs.appendFileSync(path.join(state, 'starts'), 'x')
  fs.appendFileSync(path.join(state, 'received'), '')
}
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')
const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (line) => state && fs.appendFileSync(path.join(state, 'received'), line + '\n')
let answered
const answer = new Promise((r) => (answered = r))

async function work(emitPart, begin, end, askFn) {
  begin?.()
  if (ask) {
    askFn()
    await answer
  }
  for (let i = 1; i <= parts; i++) {
    await wait(tick)
    emitPart(i)
  }
  end()
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  log(line)
  const msg = JSON.parse(line)
  if (msg.method === undefined && msg.type === undefined && msg.id !== undefined) {
    answered(msg) // the host answered the agent's own request
    return
  }
  const reply = (result) =>
    out({ ...(flavor === 'acp' ? { jsonrpc: '2.0' } : {}), id: msg.id, result })
  if (flavor === 'codex') {
    switch (msg.method) {
      case 'initialize':
        return reply({ userAgent: 'fake' })
      case 'thread/start':
      case 'thread/resume':
        return reply({ thread: { id: 'th1' } })
      case 'skills/list':
        return reply({ data: [] })
      case 'turn/start':
        reply({ turn: { id: 'tu1' } })
        return work(
          (i) =>
            out({
              method: 'item/agentMessage/delta',
              params: { threadId: 'th1', itemId: 'i1', delta: `part ${i};` },
            }),
          () => out({ method: 'turn/started', params: { threadId: 'th1', turn: { id: 'tu1' } } }),
          () =>
            out({
              method: 'turn/completed',
              params: { threadId: 'th1', turn: { id: 'tu1', status: 'completed' } },
            }),
          () =>
            out({
              id: 9001,
              method: 'item/commandExecution/requestApproval',
              params: { threadId: 'th1', itemId: 'c1', command: 'ls' },
            }),
        )
    }
  } else if (flavor === 'acp') {
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: 1,
          agentCapabilities: { sessionCapabilities: { resume: {} } },
          authMethods: [],
        })
      case 'session/new':
      case 'session/resume':
        return reply({ sessionId: 'acp1' })
      case 'session/prompt':
        return work(
          (i) =>
            out({
              jsonrpc: '2.0',
              method: 'session/update',
              params: {
                sessionId: 'acp1',
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: `part ${i};` },
                },
              },
            }),
          undefined,
          () => reply({ stopReason: 'end_turn' }),
          () =>
            out({
              jsonrpc: '2.0',
              id: 9001,
              method: 'session/request_permission',
              params: {
                sessionId: 'acp1',
                toolCall: { toolCallId: 't1', title: 'Run ls', kind: 'execute' },
                options: [
                  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
                  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
                ],
              },
            }),
        )
    }
  } else if (flavor === 'pi') {
    const ok = (data) =>
      out({ type: 'response', id: msg.id, command: msg.type, success: true, data })
    switch (msg.type) {
      case 'get_state':
        return ok({
          sessionFile: '/tmp/fake-pi.jsonl',
          model: { provider: 'p', id: 'm' },
          thinkingLevel: 'off',
        })
      case 'switch_session':
        return ok({})
      case 'prompt':
        ok({})
        return work(
          (i) =>
            out({
              type: 'message_update',
              assistantMessageEvent: { type: 'text_delta', delta: `part ${i};` },
            }),
          () => out({ type: 'agent_start' }),
          () => out({ type: 'agent_end', messages: [] }),
          () => {},
        )
      default:
        return ok({})
    }
  }
  if (msg.id !== undefined && msg.method !== undefined) reply({})
})
process.stdin.on('end', () => process.exit(0))
