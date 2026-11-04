import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'

const fake = vi.hoisted(() => ({ child: undefined as any }))
vi.mock('node:child_process', () => ({ spawn: () => fake.child }))
import { PassThrough, Duplex } from 'node:stream'
import type { Socket } from 'node:net'
import { createLogger } from '@beddcode/shared'
import { buildCliArgs, ClaudeCliProcess } from './process.ts'
import { serveApprovalMcp } from './approvalBridge.ts'
import { ClaudeCliSession } from './session.ts'

describe('CLI backend', () => {
  it('builds CLI arguments for resume and new sessions', () => {
    const args = buildCliArgs({ cwd: '/', model: 'sonnet', effort: 'high', resumeId: 'old', sessionId: 'new', permissionMode: 'default', mcpConfig: '{}', permissionPromptTool: 'mcp__beddcode__approve', additionalDirectories: ['/a', '/b'] })
    expect(args).toEqual(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--model', 'sonnet', '--effort', 'high', '--resume', 'old', '--permission-mode', 'manual', '--mcp-config', '{}', '--permission-prompt-tool', 'mcp__beddcode__approve', '--add-dir', '/a', '--add-dir', '/b'])
    expect(buildCliArgs({ cwd: '/', sessionId: 'new' })).toContain('--session-id')
  })
  it('forwards MCP tool calls over the socket and returns the decision', async () => {
    const input = new PassThrough(), output = new PassThrough(); const lines: any[] = []
    output.on('data', (data: Buffer) => lines.push(JSON.parse(data.toString())))
    const connect = (() => { const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { const request = JSON.parse(chunk.toString()); this.push(JSON.stringify({ behavior: 'allow', updatedInput: request.input })); this.push(null); callback() } }); queueMicrotask(() => socket.emit('connect')); return socket as Socket }) as typeof import('node:net').createConnection
    const server = serveApprovalMcp(input, output, '/fake', connect)
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) + '\n')
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n')
    input.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'approve', arguments: { tool_name: 'Edit', input: { x: 1 }, tool_use_id: 't' } } }) + '\n')
    await new Promise<void>((resolve) => { const poll = setInterval(() => { if (lines.length === 3) { clearInterval(poll); resolve() } }, 5) })
    expect(lines.find((x) => x.id === 2).result.tools[0].name).toBe('approve')
    expect(JSON.parse(lines.find((x) => x.id === 3).result.content[0].text)).toEqual({ behavior: 'allow', updatedInput: { x: 1 } })
    server.close(); input.destroy()
  })
  it('replays a fixture through a fake child and maps the result', async () => {
    const child = new EventEmitter() as any
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.exitCode = null; child.signalCode = null; child.kill = vi.fn()
    fake.child = child
    child.stdin.once('data', () => child.stdout.write(readFileSync(new URL('./fixtures/edit-run.jsonl', import.meta.url))))
    const session = new ClaudeCliSession({ sessionId: 's', cwd: '/tmp', permissionMode: 'bypassPermissions' }, { log: createLogger('test') })
    const events: string[] = []; const consumer = (async () => { for await (const event of session.events) events.push(event.type) })()
    await session.prompt({ text: 'edit' }); await session.close(); await consumer
    expect(events).toContain('session.provider-session'); expect(events).toContain('diff'); expect(events).toContain('session.usage'); expect(events).toContain('turn.completed')
    child.stdout.end()
  })
  it('correlates control responses with requests', async () => {
    const child = new EventEmitter() as any
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.exitCode = null; child.signalCode = null; child.kill = vi.fn()
    fake.child = child
    const process = new ClaudeCliProcess({ cwd: '/tmp' })
    const pump = (async () => { for await (const _message of process.messages()) { /* consume */ } })()
    child.stdin.once('data', (data: Buffer) => {
      const request = JSON.parse(data.toString())
      expect(request.request).toEqual({ subtype: 'set_model', model: 'opus' })
      child.stdout.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: request.request_id } }) + '\n')
    })
    await process.control({ subtype: 'set_model', model: 'opus' })
    child.exitCode = 0; child.stdout.end(); await pump
  })
  it('escalates interrupt to SIGTERM when SIGINT is ignored', async () => {
    const child = new EventEmitter() as any
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
    child.exitCode = null; child.signalCode = null; child.kill = vi.fn()
    fake.child = child
    const process = new ClaudeCliProcess({ cwd: '/tmp' })
    process.interrupt(10)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(child.kill.mock.calls).toEqual([['SIGINT'], ['SIGTERM']])
    child.emit('exit'); child.stdout.end()
  })
})
