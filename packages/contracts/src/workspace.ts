import { z } from 'zod'

/** A shell running on the host, attached to a folder. It outlives any one client connection. */
export const TerminalInfo = z.object({
  id: z.string(),
  cwd: z.string(),
  /** Shell name for the tab label, e.g. `pwsh` or `bash`. */
  shell: z.string(),
  /** What the terminal was opened to run (a project script), for its tab. */
  title: z.string().optional(),
  /** The project script it runs; running that script again in the folder replaces this terminal. */
  scriptId: z.string().optional(),
  cols: z.number().int(),
  rows: z.number().int(),
  /**
   * A session's agent terminal: the commands its agent runs, live. `pty` when they really run in
   * this terminal (ACP agents), `mirror` when the agent runs them itself and the host shows each
   * command and its output (Claude Code, Codex).
   */
  agent: z
    .object({
      sessionId: z.string(),
      /** The agent's name, e.g. `Grok`. */
      label: z.string(),
      /** The agent instance, e.g. `claude` or `acp:grok`, for its icon. */
      instanceId: z.string().optional(),
      mode: z.enum(['pty', 'mirror']),
      /** The command the agent is running now; absent when idle. */
      running: z.string().optional(),
    })
    .optional(),
  /** Typing is ignored until the user takes the terminal over (agent terminals start this way). */
  readOnly: z.boolean().optional(),
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

/** Files the Files pane shows instead of editing. */
export const MediaKind = z.enum(['image', 'video', 'audio'])
export type MediaKind = z.infer<typeof MediaKind>

/**
 * Where to fetch a media file from. `url` is relative to the host's HTTP address and holds a
 * short-lived ticket for this one file; ask again when it stops working.
 */
export const FileMedia = z.object({
  url: z.string(),
  kind: MediaKind,
  mime: z.string(),
  size: z.number().int(),
  mtime: z.number(),
})
export type FileMedia = z.infer<typeof FileMedia>

/** A folder shown while choosing one to add. Only folders are listed, never files. */
export const FolderEntry = z.object({
  name: z.string(),
  /** Absolute path on the host. */
  path: z.string(),
  isRepo: z.boolean(),
  /** Checked-out branch, read from the repository's HEAD (absent when detached or not a repo). */
  branch: z.string().optional(),
  /** Modification time in epoch milliseconds. */
  modifiedAt: z.number().optional(),
})
export type FolderEntry = z.infer<typeof FolderEntry>

/** One step of the path from the top of the file system down to a listed folder. */
export const FolderCrumb = z.object({
  name: z.string(),
  path: z.string(),
  /** The user's home folder on that host. */
  home: z.boolean().optional(),
})
export type FolderCrumb = z.infer<typeof FolderCrumb>

/** The subfolders of one folder on a host, for the in-app folder browser. */
export const FolderListing = z.object({
  path: z.string(),
  /** The folder above, or null at the top of the file system. */
  parent: z.string().nullable(),
  /** The user's home folder on the host. */
  home: z.string(),
  crumbs: z.array(FolderCrumb),
  entries: z.array(FolderEntry),
  /** More folders exist than were listed. */
  truncated: z.boolean(),
})
export type FolderListing = z.infer<typeof FolderListing>
