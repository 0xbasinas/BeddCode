import { createServer, type Server, type RequestListener } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { probeMcp } from './mcpProbe.ts'

let server: Server | undefined
afterEach(() => {
  server?.closeAllConnections()
  server?.close()
  server = undefined
})

async function listen(handler: RequestListener) {
  server = createServer(handler)
  await new Promise<void>((resolve, reject) =>
    server!.once('error', reject).listen(0, '127.0.0.1', resolve),
  )
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`
}

const result = (id: number) => ({
  jsonrpc: '2.0',
  id,
  result:
    id === 1
      ? {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'Fake', version: '1' },
          capabilities: {},
        }
      : { tools: [{ name: 'one' }] },
})

describe('probeMcp', () => {
  it.each([false, true])('initializes and lists tools, SSE framing: %s', async (sse) => {
    const url = await listen((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const message = JSON.parse(body)
        if (!message.id) {
          res.writeHead(202).end()
          return
        }
        res.setHeader('Content-Type', sse ? 'text/event-stream' : 'application/json')
        res.end(
          sse
            ? `event: message\ndata: ${JSON.stringify(result(message.id))}\n\n`
            : JSON.stringify(result(message.id)),
        )
      })
    })
    expect(await probeMcp({ url, transport: 'http' })).toEqual({
      ok: true,
      name: 'Fake',
      version: '1',
      toolCount: 1,
      tools: ['one'],
    })
  })
  it('supports legacy SSE transport', async () => {
    let stream: import('node:http').ServerResponse
    const url = await listen((req, res) => {
      if (req.method === 'GET') {
        stream = res
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('event: endpoint\ndata: /messages\n\n')
        return
      }
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        const message = JSON.parse(body)
        res.writeHead(202).end()
        if (message.id)
          stream.write(`event: message\ndata: ${JSON.stringify(result(message.id))}\n\n`)
      })
    })
    expect(await probeMcp({ url, transport: 'sse' })).toEqual({
      ok: true,
      name: 'Fake',
      version: '1',
      toolCount: 1,
      tools: ['one'],
    })
  })
  it.each([401, 404])('classifies HTTP %s', async (status) => {
    const url = await listen((_req, res) => {
      res
        .writeHead(status, {
          'WWW-Authenticate': 'Bearer resource_metadata="https://example.com/meta"',
        })
        .end()
    })
    const response = await probeMcp({
      url,
      transport: 'http',
      headers: { Authorization: 'secret-value' },
    })
    expect(response.ok).toBe(false)
    expect(JSON.stringify(response)).toContain(status === 401 ? 'OAuth resource metadata' : '404')
    expect(JSON.stringify(response)).not.toContain('secret-value')
  })
  it('times out', async () => {
    const url = await listen(() => {})
    expect(await probeMcp({ url, transport: 'http' }, 50)).toEqual({
      ok: false,
      error: 'Connection timed out.',
    })
  })
})
