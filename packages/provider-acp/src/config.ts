import { readJsonFile, writeFileAtomic } from '@beddcode/shared'
import { z } from 'zod'

export const RESERVED_IDS = new Set(['claude', 'codex', 'grok', 'fake'])

/** One configured ACP agent: a command that speaks ACP over stdio. */
export const AcpAgentConfig = z.object({
  /** Lowercase slug; the provider instance id is `acp:<id>`. */
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'use lowercase letters, digits and dashes'),
  label: z.string().min(1),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  /** Set when the agent was added from the ACP registry. */
  registryId: z.string().optional(),
})
export type AcpAgentConfig = z.infer<typeof AcpAgentConfig>

const FileShape = z.object({ version: z.literal(1), agents: z.array(AcpAgentConfig) })

export const instanceIdFor = (id: string) => `acp:${id}`

/** JSON file of configured agents. Small, rarely written, so reads are always fresh from disk. */
export class AcpAgentStore {
  constructor(private readonly file: string) {}

  list(): AcpAgentConfig[] {
    const read = readJsonFile(this.file)
    if (read.status === 'missing') return []
    if (read.status === 'corrupt')
      throw new Error(
        `Could not read ${this.file}: ${read.error}` +
          (read.quarantined ? ` (kept as ${read.quarantined}; add the agents again)` : ''),
      )
    return FileShape.parse(read.value).agents
  }

  get(id: string): AcpAgentConfig | undefined {
    return this.list().find((a) => a.id === id)
  }

  /** Adds or replaces the agent with the same id. */
  put(config: z.input<typeof AcpAgentConfig>): AcpAgentConfig {
    const parsed = AcpAgentConfig.parse(config)
    if (RESERVED_IDS.has(parsed.id)) throw new Error(`"${parsed.id}" is reserved`)
    this.write([...this.list().filter((a) => a.id !== parsed.id), parsed])
    return parsed
  }

  remove(id: string): boolean {
    const before = this.list()
    const after = before.filter((a) => a.id !== id)
    if (after.length === before.length) return false
    this.write(after)
    return true
  }

  private write(agents: AcpAgentConfig[]) {
    writeFileAtomic(this.file, JSON.stringify({ version: 1, agents }, null, 2))
  }
}
