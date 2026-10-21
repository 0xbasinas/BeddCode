import type { ModelOption } from '@beddcode/contracts'
import { JsonRpcClient, type Logger, type Transport } from '@beddcode/shared'

interface CatalogModel {
  id: string
  model: string
  displayName: string
  description?: string
  hidden?: boolean
  isDefault?: boolean
  defaultReasoningEffort?: string
  supportedReasoningEfforts?: { reasoningEffort: string }[]
}

/** Read metadata only. No thread, hooks, MCP servers, or model turn is started. */
export async function discoverCodexModels(
  transport: Transport,
  log: Logger,
  timeoutMs = 8000,
): Promise<{ models: ModelOption[]; efforts: string[] }> {
  const rpc = new JsonRpcClient(transport, log)
  let timer: ReturnType<typeof setTimeout> | undefined
  const read = async () => {
    await rpc.request('initialize', {
      clientInfo: { name: 'beddcode', title: 'BeddCode', version: '0.0.0' },
      capabilities: null,
    })
    rpc.notify('initialized')
    const entries: CatalogModel[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const page = await rpc.request<{ data: CatalogModel[]; nextCursor?: string | null }>(
        'model/list',
        { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) },
      )
      entries.push(...page.data.filter((model) => !model.hidden))
      cursor = page.nextCursor ?? undefined
      if (cursor && cursors.has(cursor)) throw new Error('Codex model catalog repeated a cursor')
      if (cursor) cursors.add(cursor)
    } while (cursor)
    const models = [
      ...new Map(
        entries.map((entry) => [
          entry.model,
          {
            id: entry.model,
            label: entry.displayName,
            description: entry.description,
            efforts: entry.supportedReasoningEfforts?.map((effort) => effort.reasoningEffort),
            defaultEffort: entry.defaultReasoningEffort,
          },
        ]),
      ).values(),
    ]
    const fallback = entries.find((model) => model.isDefault) ?? entries[0]
    return {
      models,
      efforts: fallback?.supportedReasoningEfforts?.map((e) => e.reasoningEffort) ?? [],
    }
  }
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex model discovery timed out')), timeoutMs)
      }),
    ])
  } finally {
    clearTimeout(timer)
    rpc.close()
  }
}
