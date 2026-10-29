// Run with: pnpm --filter @beddcode/server exec tsx ../../packages/mcp-gateway/test-connection.mjs
// Requires a local Worker with MCP_PASSWORD=test-client-password and HOST_SECRET=test-host-secret.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GatewayHost } from '../../apps/server/src/mcpGateway/host.ts'

const base = process.env.BEDDCODE_MCP_TEST_URL ?? 'http://127.0.0.1:8899'
const home = mkdtempSync(path.join(os.tmpdir(), 'beddcode-gateway-test-'))
let hold = false
let release
let answer
let approval
let selectedModel
let renamed
let done
writeFileSync(path.join(home, 'note.txt'), 'project contents')
const events = [
  {
    seq: 1,
    event: {
      type: 'session.created',
      sessionId: 'local',
      title: 'Local',
      instanceId: 'fake',
      cwd: home,
      model: 'fast',
      effort: 'low',
      at: 1,
    },
  },
  {
    seq: 2,
    event: {
      type: 'question.requested',
      requestId: 'question',
      questions: [{ id: 'choice', question: 'Continue?' }],
      at: 2,
    },
  },
  {
    seq: 3,
    event: {
      type: 'approval.requested',
      requestId: 'approval',
      title: 'Run command',
      options: [{ id: 'once', label: 'Allow once', kind: 'allow' }],
      at: 3,
    },
  },
]
const host = new GatewayHost({
  url: `${base.replace(/^http/, 'ws')}/host`,
  secret: 'test-host-secret',
  home,
  projects: () =>
    hold
      ? new Promise((resolve) => {
          release = resolve
        })
      : Promise.resolve([home]),
  sessions: {
    listProviders: async () => [
      {
        id: 'fake',
        label: 'Fake',
        status: 'ready',
        capabilities: {
          models: [{ id: 'fast', label: 'Fast', efforts: ['low', 'high'] }],
          permissionModes: [{ id: 'ask', label: 'Ask' }],
        },
      },
    ],
    previewAgent: async () => ({
      modes: [{ id: 'ask', label: 'Ask' }],
      config: [],
      commands: [{ name: 'review', kind: 'command' }],
    }),
    setModel: async (...args) => {
      selectedModel = args
    },
    rename: (...args) => {
      renamed = args
    },
    setDone: (...args) => {
      done = args
    },
    answerQuestion: async (...args) => {
      answer = args
    },
    approve: async (...args) => {
      approval = args
    },
  },
  store: { listSessionIds: () => [{ id: 'local', latest: 3 }], readSession: () => events },
  log: { info() {}, warn() {} },
})
const waitFor = async (condition, timeout = 15000) => {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for gateway state')
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}
const call = async (name = 'list_projects', args = {}) => {
  const response = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-client-password', 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  assert.equal(response.status, 200)
  return (await response.json()).result
}
try {
  host.start()
  await waitFor(() => host.status === 'online')
  assert.deepEqual(JSON.parse((await call()).content[0].text), { projects: [home] })
  assert.equal(
    JSON.parse((await call('list_sessions')).content[0].text).sessions[0].sessionId,
    'local',
  )
  assert.equal(
    JSON.parse((await call('get_session_events', { session_id: 'local' })).content[0].text).events
      .length,
    3,
  )
  assert.equal(
    JSON.parse(
      (await call('read_project_file', { project: home, path: 'note.txt' })).content[0].text,
    ).content,
    'project contents',
  )
  assert.equal(
    JSON.parse((await call('get_pending_requests', { session_id: 'local' })).content[0].text)
      .requests.length,
    2,
  )
  await call('answer_question', {
    session_id: 'local',
    request_id: 'question',
    answers: { choice: ['Yes'] },
  })
  await call('resolve_approval', { session_id: 'local', request_id: 'approval', option_id: 'once' })
  assert.deepEqual(answer, ['local', 'question', { choice: ['Yes'] }])
  assert.deepEqual(approval, ['local', 'approval', 'once'])
  assert.equal(
    JSON.parse((await call('get_agent_options', { agent: 'fake', project: home })).content[0].text)
      .commands[0].name,
    'review',
  )
  assert.equal(
    JSON.parse((await call('get_session_options', { session_id: 'local' })).content[0].text).model,
    'fast',
  )
  assert.equal(
    (await call('set_session_model', { session_id: 'local', effort: 'high' })).isError,
    undefined,
  )
  await call('rename_session', { session_id: 'local', title: 'Renamed' })
  await call('set_session_done', { session_id: 'local', done: true })
  assert.deepEqual(selectedModel, ['local', 'fast', 'high'])
  assert.deepEqual(renamed, ['local', 'Renamed'])
  assert.deepEqual(done, ['local', true])
  hold = true
  const interrupted = call()
  await waitFor(() => release)
  host.socket.terminate()
  const result = await interrupted
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /may have started/)
  release([])
  hold = false
  await waitFor(() => host.status === 'online')
  assert.deepEqual(JSON.parse((await call()).content[0].text), { projects: [home] })
  console.log('Session, file, question, approval, disconnect, and reconnect checks passed.')
} finally {
  host.stop()
  rmSync(home, { recursive: true, force: true })
}
