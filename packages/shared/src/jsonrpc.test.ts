import { describe, expect, it } from 'vitest'
import {
  JsonRpcClient,
  JsonRpcError,
  describeRpcError,
  rpcErrorDetail,
  spawnTransport,
  type Transport,
} from './jsonrpc.ts'

function pipe() {
  let onLine: (line: string) => void = () => {}
  const sent: Record<string, unknown>[] = []
  const transport: Transport = {
    send: (line) => void sent.push(JSON.parse(line)),
    onLine: (h) => (onLine = h),
    onClose: () => {},
    close: () => {},
  }
  return { transport, sent, feed: (message: unknown) => onLine(JSON.stringify(message)) }
}

describe('JsonRpcClient', () => {
  it('keeps what the other end attached to an error', async () => {
    const { transport, feed } = pipe()
    const rpc = new JsonRpcClient(transport)
    const pending = rpc.request('session/new')
    feed({
      id: 1,
      error: { code: -32000, message: 'Internal error', data: { code: 'FS_NOT_FOUND' } },
    })
    const err = await pending.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(JsonRpcError)
    expect((err as JsonRpcError).code).toBe(-32000)
    expect((err as JsonRpcError).data).toEqual({ code: 'FS_NOT_FOUND' })
  })

  it('matches an answer whose id came back as a string', async () => {
    const { transport, feed } = pipe()
    const rpc = new JsonRpcClient(transport)
    const pending = rpc.request('initialize')
    feed({ id: '1', result: { ok: true } })
    expect(await pending).toEqual({ ok: true })
  })

  it('sends an error with its data when answering a request fails that way', async () => {
    const { transport, sent, feed } = pipe()
    const rpc = new JsonRpcClient(transport)
    rpc.onRequest(async () => {
      throw new JsonRpcError(-32602, 'bad', { why: 'because' })
    })
    feed({ id: 9, method: 'x', params: {} })
    await new Promise((r) => setTimeout(r, 5))
    expect(sent.at(-1)).toMatchObject({
      id: 9,
      error: { code: -32602, message: 'bad', data: { why: 'because' } },
    })
  })

  it('ignores a line that is not JSON', () => {
    const { transport } = pipe()
    const rpc = new JsonRpcClient(transport)
    let got = false
    rpc.onNotification(() => (got = true))
    transport.onLine(() => {})
    expect(got).toBe(false)
  })
})

describe('rpcErrorDetail and describeRpcError', () => {
  it('finds the reason under the usual keys, also nested', () => {
    expect(rpcErrorDetail({ details: ' Not signed in ' })).toBe('Not signed in')
    expect(rpcErrorDetail({ error: { message: 'quota used up' } })).toBe('quota used up')
    expect(rpcErrorDetail({ code: 5 })).toBeUndefined()
    expect(rpcErrorDetail('text')).toBeUndefined()
    expect(rpcErrorDetail([1, 2])).toBeUndefined()
  })

  it('puts the reason after the message, once', () => {
    expect(
      describeRpcError(new JsonRpcError(-32000, 'Internal error', { details: 'no API key' })),
    ).toBe('Internal error: no API key')
    expect(describeRpcError(new JsonRpcError(-1, 'no API key', { details: 'no API key' }))).toBe(
      'no API key',
    )
    expect(describeRpcError(new Error('plain'))).toBe('plain')
    expect(describeRpcError('text')).toBe('text')
  })
})

describe('spawnTransport close', () => {
  it('ends a child that ignores its closed input', async () => {
    const transport = spawnTransport(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {})
    const closed = new Promise<void>((resolve) => transport.onClose(() => resolve()))
    transport.close()
    await closed
  }, 10_000)
})
