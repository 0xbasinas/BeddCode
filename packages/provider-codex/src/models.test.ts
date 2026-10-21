import { describe, expect, it } from 'vitest'
import { createLogger, type Transport } from '@beddcode/shared'
import { discoverCodexModels } from './models.ts'

function catalog(pages: Record<string, unknown>, silent = false) {
  let receive = (_line: string) => {}
  const calls: { id: number; method: string; params?: Record<string, unknown> }[] = []
  let closed = false
  const transport: Transport = {
    onLine: (handler) => {
      receive = handler
    },
    onClose: () => {},
    close: () => {
      closed = true
    },
    send: (line) => {
      const call = JSON.parse(line) as (typeof calls)[number]
      calls.push(call)
      if (silent || !call.id) return
      const result = call.method === 'initialize' ? {} : pages[String(call.params?.cursor ?? '')]
      queueMicrotask(() => receive(JSON.stringify({ id: call.id, result })))
    },
  }
  return { transport, calls, closed: () => closed }
}
const log = createLogger('models-test', 'error')
const model = (model: string, efforts: string[], isDefault = false) => ({
  id: `preset-${model}`,
  model,
  displayName: model.toUpperCase(),
  isDefault,
  defaultReasoningEffort: efforts[0],
  supportedReasoningEfforts: efforts.map((reasoningEffort) => ({ reasoningEffort })),
})

describe('Codex model discovery', () => {
  it('reads all pages, filters hidden models, and preserves model slugs and advertised effort order', async () => {
    const fake = catalog({
      '': {
        data: [model('deep', ['high', 'xhigh'], true), { ...model('hidden', []), hidden: true }],
        nextCursor: 'next',
      },
      next: { data: [model('fast', ['minimal', 'low'])], nextCursor: null },
    })
    const result = await discoverCodexModels(fake.transport, log)
    expect(result.models.map((m) => m.id)).toEqual(['deep', 'fast'])
    expect(result.models[0]).toMatchObject({
      label: 'DEEP',
      efforts: ['high', 'xhigh'],
      defaultEffort: 'high',
    })
    expect(result.efforts).toEqual(['high', 'xhigh'])
    expect(fake.calls.map((c) => c.method)).toEqual([
      'initialize',
      'initialized',
      'model/list',
      'model/list',
    ])
    expect(fake.calls.at(-1)?.params?.cursor).toBe('next')
    expect(fake.closed()).toBe(true)
    expect(
      fake.calls.some((c) => c.method.startsWith('thread/') || c.method.startsWith('turn/')),
    ).toBe(false)
  })
  it('stops a stalled discovery and closes its metadata process', async () => {
    const fake = catalog({}, true)
    await expect(discoverCodexModels(fake.transport, log, 10)).rejects.toThrow('timed out')
    expect(fake.closed()).toBe(true)
  })
  it('rejects repeated pagination cursors and always closes the transport', async () => {
    const fake = catalog({
      '': { data: [], nextCursor: 'repeat' },
      repeat: { data: [], nextCursor: 'repeat' },
    })
    await expect(discoverCodexModels(fake.transport, log)).rejects.toThrow('repeated a cursor')
    expect(fake.closed()).toBe(true)
  })
})
