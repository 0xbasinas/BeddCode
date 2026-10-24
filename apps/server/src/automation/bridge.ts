import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * A tiny stdio MCP server the agents start. It answers the handshake itself and passes tool
 * listing and calls to the host over loopback HTTP, with the session's own key. Self-contained so
 * it runs with plain Node, or with the desktop app's Electron in Node mode.
 */
export const BRIDGE_SOURCE = `// Written by BeddCode. Lets an agent start and manage other BeddCode sessions.
import { createInterface } from 'node:readline'

const url = process.env.BEDDCODE_TOOLS_URL
const token = process.env.BEDDCODE_TOOLS_TOKEN
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')

async function host(method, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ method, params }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || body.error) throw new Error(body.error || 'BeddCode answered ' + res.status)
  return body.result
}

createInterface({ input: process.stdin }).on('line', async (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg === null || typeof msg !== 'object' || msg.id === undefined || !msg.method) return
  const reply = (result) => send({ jsonrpc: '2.0', id: msg.id, result })
  const fail = (code, message) => send({ jsonrpc: '2.0', id: msg.id, error: { code, message } })
  try {
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'beddcode', version: '1.0.0' },
          instructions: await host('instructions').catch(() => undefined),
        })
      case 'ping':
        return reply({})
      case 'tools/list':
        return reply(await host('tools/list'))
      case 'tools/call':
        return reply(await host('tools/call', msg.params))
      default:
        return fail(-32601, 'Method not found: ' + msg.method)
    }
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err)
    if (msg.method === 'tools/call') return reply({ content: [{ type: 'text', text }], isError: true })
    fail(-32603, text)
  }
})
`

/** Writes the bridge next to the host's data and returns its path. */
export function writeBridge(home: string): string {
  mkdirSync(home, { recursive: true })
  const file = path.join(home, 'agent-tools-mcp.mjs')
  writeFileSync(file, BRIDGE_SOURCE, { mode: 0o644 })
  return file
}
