import { createServer, createConnection, type Server, type Socket } from 'node:net'
import { createInterface } from 'node:readline'
import { unlink } from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import type { Readable, Writable } from 'node:stream'

export interface ApprovalRequest {
  tool_name: string
  input: Record<string, unknown>
  tool_use_id: string
}
export type ApprovalAnswer =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
export const SOCKET_ENV = 'BEDDCODE_APPROVAL_SOCKET'

export class ApprovalBridge extends EventEmitter {
  private server?: Server
  private sockets = new Set<Socket>()
  private pending = new Map<string, (answer: ApprovalAnswer) => void>()
  private count = 0
  constructor(readonly path: string) {
    super()
  }
  async start() {
    this.server = createServer((socket) => {
      this.sockets.add(socket)
      socket.on('error', () => {})
      socket.on('close', () => this.sockets.delete(socket))
      const lines = createInterface({ input: socket })
      lines.on('line', (line) => {
        try {
          const request = JSON.parse(line) as ApprovalRequest
          const id = String(++this.count)
          this.pending.set(id, (answer) => {
            if (!socket.destroyed) socket.end(JSON.stringify(answer) + '\n')
          })
          socket.once('close', () => this.pending.delete(id))
          this.emit('request', id, request)
        } catch {
          socket.end(JSON.stringify({ behavior: 'deny', message: 'Invalid request' }) + '\n')
        }
      })
    })
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(this.path, () => {
        this.server!.off('error', reject)
        resolve()
      })
    })
  }
  resolve(id: string, answer: ApprovalAnswer) {
    const callback = this.pending.get(id)
    if (!callback) return false
    this.pending.delete(id)
    callback(answer)
    return true
  }
  async stop() {
    for (const id of this.pending.keys())
      this.resolve(id, { behavior: 'deny', message: 'Session closed' })
    for (const socket of this.sockets) socket.end()
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    await unlink(this.path).catch(() => {})
  }
}

export function serveApprovalMcp(
  input: Readable,
  output: Writable,
  socketPath: string,
  connect = createConnection,
) {
  const send = (message: unknown) => output.write(JSON.stringify(message) + '\n')
  const lines = createInterface({ input })
  lines.on('line', (line) => {
    void (async () => {
      let msg: { id?: string | number; method?: string; params?: { arguments?: ApprovalRequest } }
      try {
        msg = JSON.parse(line)
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })
        return
      }
      if (msg.id === undefined) return
      let result: unknown
      if (msg.method === 'initialize')
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'beddcode', version: '1.0.0' },
        }
      else if (msg.method === 'tools/list')
        result = {
          tools: [
            {
              name: 'approve',
              description: 'Ask the host to approve a tool call',
              inputSchema: {
                type: 'object',
                properties: {
                  tool_name: { type: 'string' },
                  input: { type: 'object' },
                  tool_use_id: { type: 'string' },
                },
                required: ['tool_name', 'input', 'tool_use_id'],
              },
            },
          ],
        }
      else if (msg.method === 'tools/call') {
        const answer = await new Promise<ApprovalAnswer>((resolve) => {
          const socket = connect(socketPath)
          let data = ''
          socket.on('connect', () =>
            socket.write(JSON.stringify(msg.params?.arguments ?? {}) + '\n'),
          )
          socket.on('data', (chunk) => {
            data += chunk.toString()
          })
          socket.on('end', () => {
            try {
              resolve(JSON.parse(data) as ApprovalAnswer)
            } catch {
              resolve({ behavior: 'deny', message: 'Invalid host response' })
            }
          })
          socket.on('error', () =>
            resolve({ behavior: 'deny', message: 'Approval host unavailable' }),
          )
        })
        result = { content: [{ type: 'text', text: JSON.stringify(answer) }] }
      } else {
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
        return
      }
      send({ jsonrpc: '2.0', id: msg.id, result })
    })()
  })
  return lines
}
