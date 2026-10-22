import { create } from 'zustand'
import type { FileEntry, MediaKind, RpcMethodName, RpcParams, RpcResult } from '@beddcode/contracts'
import { hostRequest } from '../../stores/host.ts'
import { LOCAL_HOST_KEY } from '../../stores/hostCatalog.ts'
import { mediaKindOf } from './mediaKind.ts'

/**
 * Names one folder on one host. The store's `cwd` arguments are these ids; a bare path means the
 * local host.
 */
// NUL cannot appear in a path, so a host key joined to a path with it cannot clash with one.
const SEPARATOR = String.fromCharCode(0)
export const folderId = (hostKey: string, cwd: string) => `${hostKey}${SEPARATOR}${cwd}`
export function splitFolderId(id: string): { hostKey: string; cwd: string } {
  const at = id.indexOf(SEPARATOR)
  return at < 0
    ? { hostKey: LOCAL_HOST_KEY, cwd: id }
    : { hostKey: id.slice(0, at), cwd: id.slice(at + 1) }
}

/** A file request for the folder `id`, sent to the host it lives on. */
function request<M extends RpcMethodName>(
  id: string,
  method: M,
  params: Omit<RpcParams<M>, 'cwd'>,
): Promise<RpcResult<M>> {
  const { hostKey, cwd } = splitFolderId(id)
  return hostRequest(hostKey, method, { ...params, cwd } as RpcParams<M>)
}

export interface Doc {
  path: string
  /** Text as last loaded from or saved to disk. */
  content: string
  /** Unsaved text retained when the pane or Settings changes. Never written until Save. */
  draft?: string
  mtime: number
  size: number
  binary: boolean
  tooLarge: boolean
  /** An image, video or audio file: shown, not edited. */
  media?: MediaKind
  dirty: boolean
  /** The file changed on disk while there were unsaved edits. */
  conflict: boolean
  /** Bumped whenever the content is replaced from disk, so the editor reloads it. */
  version: number
  error?: string
}

/** What the files pane remembers about one folder. */
export interface FolderFiles {
  /** Listings by folder path (`''` is the root). Absent means not loaded yet. */
  entries: Record<string, FileEntry[]>
  expanded: Record<string, boolean>
  tabs: string[]
  active?: string
  docs: Record<string, Doc>
}

const empty = (): FolderFiles => ({ entries: {}, expanded: {}, tabs: [], docs: {} })

interface FilesState {
  byCwd: Record<string, FolderFiles>
  loadDir(cwd: string, dir: string): Promise<void>
  toggleDir(cwd: string, dir: string): Promise<void>
  collapseAll(cwd: string): void
  open(cwd: string, path: string): Promise<void>
  activate(cwd: string, path: string): void
  close(cwd: string, path: string): void
  setDirty(cwd: string, path: string, dirty: boolean): void
  setDraft(cwd: string, path: string, text: string): void
  save(cwd: string, path: string, content: string, force?: boolean): Promise<void>
  reload(cwd: string, path: string): Promise<void>
  create(cwd: string, path: string, type: 'file' | 'dir'): Promise<void>
  /** Applies `fs.changed` paths: refreshes listings and open files. */
  changed(cwd: string, paths: string[]): void
}

const parentOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')

export const useFiles = create<FilesState>((set, get) => {
  const update = (cwd: string, fn: (f: FolderFiles) => FolderFiles) =>
    set((s) => ({ byCwd: { ...s.byCwd, [cwd]: fn(s.byCwd[cwd] ?? empty()) } }))
  const patchDoc = (cwd: string, path: string, patch: Partial<Doc>) =>
    update(cwd, (f) =>
      f.docs[path] ? { ...f, docs: { ...f.docs, [path]: { ...f.docs[path]!, ...patch } } } : f,
    )

  return {
    byCwd: {},

    async loadDir(cwd, dir) {
      const { entries } = await request(cwd, 'files.list', { dir })
      update(cwd, (f) => ({ ...f, entries: { ...f.entries, [dir]: entries } }))
    },

    async toggleDir(cwd, dir) {
      const folder = get().byCwd[cwd] ?? empty()
      const open = !folder.expanded[dir]
      update(cwd, (f) => ({ ...f, expanded: { ...f.expanded, [dir]: open } }))
      if (open && !folder.entries[dir]) await get().loadDir(cwd, dir)
    },

    collapseAll(cwd) {
      update(cwd, (f) => ({ ...f, expanded: {} }))
    },

    async open(cwd, path) {
      const folder = get().byCwd[cwd] ?? empty()
      if (folder.docs[path]) return get().activate(cwd, path)
      try {
        const kind = mediaKindOf(path)
        const shown = kind ? await request(cwd, 'files.media', { path }) : null
        const file = shown
          ? { content: '', mtime: shown.mtime, size: shown.size, binary: false, tooLarge: false }
          : await request(cwd, 'files.read', { path })
        const doc: Doc = {
          media: shown?.kind,
          path,
          content: file.content,
          mtime: file.mtime,
          size: file.size,
          binary: file.binary,
          tooLarge: file.tooLarge,
          dirty: false,
          conflict: false,
          version: 0,
        }
        update(cwd, (f) => ({
          ...f,
          tabs: f.tabs.includes(path) ? f.tabs : [...f.tabs, path],
          active: path,
          docs: { ...f.docs, [path]: doc },
        }))
      } catch (err) {
        update(cwd, (f) => ({
          ...f,
          tabs: f.tabs.includes(path) ? f.tabs : [...f.tabs, path],
          active: path,
          docs: {
            ...f.docs,
            [path]: {
              path,
              content: '',
              mtime: 0,
              size: 0,
              binary: false,
              tooLarge: false,
              dirty: false,
              conflict: false,
              version: 0,
              error: err instanceof Error ? err.message : String(err),
            },
          },
        }))
      }
    },

    activate(cwd, path) {
      update(cwd, (f) => ({ ...f, active: path }))
    },

    close(cwd, path) {
      update(cwd, (f) => {
        const index = f.tabs.indexOf(path)
        const tabs = f.tabs.filter((t) => t !== path)
        const { [path]: _gone, ...docs } = f.docs
        const active = f.active === path ? (tabs[index] ?? tabs[index - 1]) : f.active
        return { ...f, tabs, docs, active }
      })
    },

    setDirty(cwd, path, dirty) {
      patchDoc(cwd, path, { dirty })
    },

    setDraft(cwd, path, text) {
      const doc = get().byCwd[cwd]?.docs[path]
      if (doc)
        patchDoc(cwd, path, {
          draft: text === doc.content ? undefined : text,
          dirty: text !== doc.content,
        })
    },

    async save(cwd, path, content, force = false) {
      const doc = get().byCwd[cwd]?.docs[path]
      if (!doc) return
      try {
        const { mtime } = await request(cwd, 'files.write', {
          path,
          content,
          expectedMtime: force ? undefined : doc.mtime,
        })
        const latest = get().byCwd[cwd]?.docs[path]
        const draft =
          latest && latest.draft !== doc.draft ? (latest.draft ?? latest.content) : undefined
        patchDoc(cwd, path, {
          content,
          mtime,
          draft: draft === content ? undefined : draft,
          dirty: draft !== undefined && draft !== content,
          conflict: false,
          size: new TextEncoder().encode(content).length,
        })
      } catch (err) {
        if (err instanceof Error && /changed on disk/i.test(err.message)) {
          patchDoc(cwd, path, { conflict: true })
        }
        throw err
      }
    },

    async reload(cwd, path) {
      const doc = get().byCwd[cwd]?.docs[path]
      if (doc?.media) {
        // Shown, not edited: just have the viewer fetch it again.
        const shown = await request(cwd, 'files.media', { path })
        if (shown)
          patchDoc(cwd, path, { mtime: shown.mtime, size: shown.size, version: doc.version + 1 })
        return
      }
      const file = await request(cwd, 'files.read', { path })
      patchDoc(cwd, path, {
        content: file.content,
        mtime: file.mtime,
        size: file.size,
        binary: file.binary,
        tooLarge: file.tooLarge,
        dirty: false,
        draft: undefined,
        conflict: false,
        version: (doc?.version ?? 0) + 1,
      })
    },

    async create(cwd, path, type) {
      await request(cwd, 'files.create', { path, type })
      const parent = parentOf(path)
      // Make the new entry visible: expand every folder on the way to it.
      const parts = parent ? parent.split('/') : []
      for (let i = 1; i <= parts.length; i++) {
        const dir = parts.slice(0, i).join('/')
        update(cwd, (f) => ({ ...f, expanded: { ...f.expanded, [dir]: true } }))
      }
      await Promise.all([
        get().loadDir(cwd, ''),
        ...parts.map((_, i) => get().loadDir(cwd, parts.slice(0, i + 1).join('/'))),
      ])
      if (type === 'file') await get().open(cwd, path)
    },

    changed(cwd, paths) {
      const folder = get().byCwd[cwd]
      if (!folder) return
      const everything = paths.includes('.')

      // Listings that might have changed: parents of changed paths (or all loaded ones).
      const dirs = new Set(
        everything
          ? Object.keys(folder.entries)
          : paths.map(parentOf).filter((d) => d in folder.entries),
      )
      for (const dir of dirs)
        void get()
          .loadDir(cwd, dir)
          .catch(() => {})

      // Open files: take the new text when nothing is unsaved, otherwise flag the conflict.
      for (const [path, doc] of Object.entries(folder.docs)) {
        if (!everything && !paths.includes(path)) continue
        if (doc.dirty) patchDoc(cwd, path, { conflict: true })
        else
          void get()
            .reload(cwd, path)
            .catch(() => {})
      }
    },
  }
})

export const EMPTY_FOLDER: FolderFiles = empty()
