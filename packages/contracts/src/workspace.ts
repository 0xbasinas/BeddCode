import { z } from 'zod'

/** A shell running on the host, attached to a folder. It outlives any one client connection. */
export const TerminalInfo = z.object({
  id: z.string(),
  cwd: z.string(),
  /** Shell name for the tab label, e.g. `pwsh` or `bash`. */
  shell: z.string(),
  cols: z.number().int(),
  rows: z.number().int(),
  /** Exit code once the shell has ended (null when killed by a signal); absent while running. */
  exited: z.number().int().nullable().optional(),
  createdAt: z.number().int(),
})
export type TerminalInfo = z.infer<typeof TerminalInfo>

export const FileEntry = z.object({
  name: z.string(),
  type: z.enum(['file', 'dir']),
  size: z.number().int().optional(),
  /** Build output, dependencies and similar: shown dimmed. */
  ignored: z.boolean().optional(),
})
export type FileEntry = z.infer<typeof FileEntry>

export const FileContent = z.object({
  path: z.string(),
  content: z.string(),
  /** Modification time in epoch milliseconds, used to detect changes made meanwhile. */
  mtime: z.number(),
  size: z.number().int(),
  /** Binary files are not loaded into the editor. */
  binary: z.boolean(),
  /** Larger than the editor limit; `content` is empty. */
  tooLarge: z.boolean(),
})
export type FileContent = z.infer<typeof FileContent>
