import type { ModelInfo, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ModelOption } from '@beddcode/contracts'
import { createAsyncQueue } from '@beddcode/shared'
import type { QueryFn } from './session.ts'

/** Read the installed CLI's catalog without sending a prompt or starting customizations. */
export async function discoverClaudeModels(
  queryFn: QueryFn,
  executablePath: string,
  env?: Record<string, string | undefined>,
  timeoutMs = 8000,
): Promise<ModelOption[]> {
  const prompts = createAsyncQueue<SDKUserMessage>()
  const abortController = new AbortController()
  let query: Query | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    query = queryFn({
      prompt: prompts,
      options: {
        pathToClaudeCodeExecutable: executablePath,
        env: { ...process.env, ...env },
        abortController,
        persistSession: false,
        settingSources: ['user', 'project', 'local'],
        // Bare mode also disables managed hooks and credential helpers. Catalog reads
        // need no model request or credentials; actual sessions keep normal settings.
        extraArgs: { bare: null },
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        settings: { disableAllHooks: true },
      },
    })
    const entries = await Promise.race([
      query.supportedModels(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Claude model discovery timed out')), timeoutMs)
      }),
    ])
    if (entries.length === 0) throw new Error('Claude returned an empty model catalog')
    return entries.map((entry) => ({
      id: entry.value,
      label: modelLabel(entry),
      description: entry.description,
      efforts: entry.supportsEffort === false ? [] : (entry.supportedEffortLevels ?? []),
    }))
  } finally {
    clearTimeout(timer)
    query?.close()
    abortController.abort()
    prompts.close()
  }
}

function modelLabel(entry: ModelInfo): string {
  // Some CLI versions keep displayName generic and put the versioned name at the
  // start of the description, e.g. "Sonnet 5.5 · Efficient for routine tasks".
  const name = entry.description.split(' · ')[0]?.trim() ?? ''
  const prefix = `${entry.displayName} `
  return name.startsWith(prefix) && /^\d/.test(name.slice(prefix.length)) ? name : entry.displayName
}
