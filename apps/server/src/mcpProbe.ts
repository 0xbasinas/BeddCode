type ProbeResult =
  | { ok: true; name: string; version: string; toolCount: number; tools: string[] }
  | { ok: false; error: string }

class ProbeError extends Error {}

/** Probe a remote MCP server without exposing request headers or response bodies in errors. */
export async function probeMcp(
  input: { url: string; transport: 'http' | 'sse'; headers?: Record<string, string> },
  timeoutMs = 5000,
): Promise<ProbeResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const url = new URL(input.url)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new ProbeError('Enter a valid HTTP or HTTPS server URL.')
    }
    const headers = new Headers(input.headers)
    headers.set('Accept', 'application/json, text/event-stream')
    headers.set('Content-Type', 'application/json')
    const check = (response: Response) => {
      if (response.status === 401 || response.status === 403) {
        const oauth = /resource_metadata\s*=/i.test(response.headers.get('www-authenticate') ?? '')
        throw new ProbeError(
          `Authentication required (${response.status}).${oauth ? ' OAuth resource metadata is advertised.' : ''}`,
        )
      }
      if (response.status === 404)
        throw new ProbeError('Server path not found (404). Check the URL path.')
      if (!response.ok) throw new ProbeError('The server returned an HTTP error.')
    }
    const send = async (target: URL, message: object, session?: string) => {
      const requestHeaders = new Headers(headers)
      if (session) requestHeaders.set('Mcp-Session-Id', session)
      if ('method' in message && message.method !== 'initialize')
        requestHeaders.set('Mcp-Protocol-Version', '2025-06-18')
      const response = await fetch(target, {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify(message),
        signal: controller.signal,
        redirect: 'error',
      })
      check(response)
      return response
    }
    const initialize = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'BeddCode', version: '1.0.0' },
      },
    }
    const tools = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    const decoder = new TextDecoder()
    let buffer = ''
    const nextEvent = async () => {
      if (!reader) throw new ProbeError('Not an MCP server: missing event stream.')
      while (true) {
        const match = /\r?\n\r?\n/.exec(buffer)
        if (match) {
          const frame = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)
          const event = frame.match(/^event:\s*(.*)$/m)?.[1]?.trim() ?? 'message'
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n')
          if (data) return { event, data }
          continue
        }
        const chunk = await reader.read()
        if (chunk.done) throw new ProbeError('Not an MCP server: incomplete event stream.')
        buffer += decoder.decode(chunk.value, { stream: true })
        if (buffer.length > 1024 * 1024)
          throw new ProbeError('Protocol error: response is too large.')
      }
    }
    const parse = (data: string, id: number) => {
      let value: any
      try {
        value = JSON.parse(data)
      } catch {
        throw new ProbeError('Not an MCP server: invalid JSON response.')
      }
      if (value?.jsonrpc !== '2.0' || value.id !== id || value.error || !value.result)
        throw new ProbeError('Protocol error: invalid MCP response.')
      return value.result
    }
    const streamResult = async (id: number) => {
      while (true) {
        const event = await nextEvent()
        if (event.event !== 'message') continue
        let value: any
        try {
          value = JSON.parse(event.data)
        } catch {
          throw new ProbeError('Not an MCP server: invalid JSON response.')
        }
        if (value.id === id) return parse(event.data, id)
      }
    }
    const responseResult = async (response: Response, id: number) => {
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        reader = response.body?.getReader()
        buffer = ''
        const result = await streamResult(id)
        await reader?.cancel()
        reader = undefined
        return result
      }
      return parse(await response.text(), id)
    }
    let initialized: any
    let listed: any
    if (input.transport === 'sse') {
      const response = await fetch(url, { headers, signal: controller.signal, redirect: 'error' })
      check(response)
      if (!response.headers.get('content-type')?.includes('text/event-stream'))
        throw new ProbeError('Not an MCP server: expected an event stream.')
      reader = response.body?.getReader()
      let endpoint: URL | undefined
      while (!endpoint) {
        const event = await nextEvent()
        if (event.event === 'endpoint') endpoint = new URL(event.data, url)
      }
      if (endpoint.origin !== url.origin)
        throw new ProbeError('Protocol error: endpoint has a different origin.')
      await send(endpoint, initialize)
      initialized = await streamResult(1)
      await send(endpoint, { jsonrpc: '2.0', method: 'notifications/initialized' })
      await send(endpoint, tools)
      listed = await streamResult(2)
    } else {
      const response = await send(url, initialize)
      const session = response.headers.get('mcp-session-id') ?? undefined
      initialized = await responseResult(response, 1)
      await send(url, { jsonrpc: '2.0', method: 'notifications/initialized' }, session)
      listed = await responseResult(await send(url, tools, session), 2)
    }
    if (
      typeof initialized?.serverInfo?.name !== 'string' ||
      typeof initialized.serverInfo.version !== 'string' ||
      !Array.isArray(listed?.tools)
    )
      throw new ProbeError('Protocol error: missing server information or tools list.')
    const safe = (value: string) =>
      Object.values(input.headers ?? {}).some((secret) => secret && value.includes(secret))
        ? '[redacted]'
        : value
    return {
      ok: true,
      name: safe(initialized.serverInfo.name),
      version: safe(initialized.serverInfo.version),
      toolCount: listed.tools.length,
      tools: listed.tools.map((t: { name?: unknown }) => String(t.name ?? '')).filter(Boolean),
    }
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, error: 'Connection timed out.' }
    if (error instanceof ProbeError) return { ok: false, error: error.message }
    if (
      error instanceof TypeError &&
      error.cause &&
      /CERT|TLS|SSL/i.test(String((error.cause as NodeJS.ErrnoException).code))
    )
      return { ok: false, error: 'TLS connection failed. Check the server certificate.' }
    if (error instanceof TypeError)
      return { ok: false, error: 'Server unreachable. Check the address and DNS.' }
    return { ok: false, error: 'Not an MCP server or invalid server URL.' }
  } finally {
    clearTimeout(timer)
    controller.abort()
    void reader?.cancel().catch(() => {})
  }
}
