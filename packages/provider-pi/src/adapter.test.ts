import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { createLogger } from '@beddcode/shared'
import { createPiAdapter, parsePiModels, type PiSpawn } from './adapter.ts'

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough; pid: number; exitCode: number | null; kill(): boolean }
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.pid = 5; child.exitCode = null; child.kill = () => true
  child.stdin.on('data', (chunk) => {
    const request = JSON.parse(String(chunk)) as { id: string; type: string }
    const data = request.type === 'get_state' ? { sessionFile: '/tmp/pi-session.jsonl' } : request.type === 'get_available_models' ? { models: [{ provider: 'openai', id: 'gpt-5', name: 'GPT 5', reasoning: true }] } : request.type === 'get_commands' ? { commands: [{ name: 'review', source: 'skill' }] } : {}
    child.stdout.write(`${JSON.stringify({ type: 'response', id: request.id, command: request.type, success: true, data })}\n`)
  })
  return child
}

describe('Pi adapter', () => {
  it('parses configured Pi models with provider-qualified IDs', () => {
    expect(parsePiModels([{ provider: 'anthropic', id: 'sonnet', name: 'Sonnet', reasoning: true }])).toEqual([
      { id: 'anthropic/sonnet', label: 'Sonnet', efforts: ['off', 'minimal', 'low', 'medium', 'high'] },
    ])
  })
  it('detects a missing Pi installation', async () => {
    const [instance] = await createPiAdapter({ executablePath: 'C:/missing/pi' }).detect()
    expect(instance).toMatchObject({ kind: 'pi', status: 'not-installed' })
  })
  it('uses RPC, reports provider session, config, tools and turn completion', async () => {
    const child = fakeChild()
    const spawnFn: PiSpawn = () => child as never
    const adapter = createPiAdapter({ executablePath: process.execPath, sessionDir: '/tmp/bedd-pi', spawnFn, log: createLogger('test', 'error') })
    const session = await adapter.startSession('pi', { sessionId: 's1', cwd: '/work' })
    const events: any[] = []
    const consume = (async () => { for await (const event of session.events) events.push(event) })()
    await session.prompt({ text: 'hello' })
    child.stdout.write(`${JSON.stringify({ type: 'agent_start' })}\n`)
    child.stdout.write(`${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hi' } })}\n`)
    child.stdout.write(`${JSON.stringify({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash', args: { command: 'pwd' } })}\n`)
    child.stdout.write(`${JSON.stringify({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash', result: { content: [{ type: 'text', text: '/work' }] }, isError: false })}\n`)
    child.stdout.write(`${JSON.stringify({ type: 'agent_end', messages: [{ role: 'assistant', stopReason: 'stop', model: 'gpt-5', usage: { input: 2, output: 3, cost: { total: 0.01 } } }] })}\n`)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'session.provider-session', providerSessionId: '/tmp/pi-session.jsonl' }),
      expect.objectContaining({ type: 'session.config' }),
      expect.objectContaining({ type: 'message.delta', text: 'Hi' }),
      expect.objectContaining({ type: 'tool.started', toolId: 't1', kind: 'command', command: 'pwd' }),
      expect.objectContaining({ type: 'tool.completed', toolId: 't1', ok: true }),
      expect.objectContaining({ type: 'turn.completed', reason: 'done' }),
    ]))
    await session.close(); await consume
  })
})
