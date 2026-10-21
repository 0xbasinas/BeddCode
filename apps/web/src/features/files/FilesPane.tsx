import { useEffect, useRef, useState } from 'react'
import { File, FilePlus, FolderOpen, FolderPlus, Search, X, ChevronsDownUp } from 'lucide-react'
import type { SessionView } from '@beddcode/client-runtime'
import { hostRequest, onHostFrame, sendHostFrame, useHostStore } from '../../stores/host.ts'
import { formatBytes } from '../../ui/format.ts'
import { Editor, type EditorPosition } from './Editor.tsx'
import { FileTree } from './FileTree.tsx'
import { baseName, languageName } from './fileIcons.ts'
import { EMPTY_FOLDER, useFiles } from './filesStore.ts'

/** Browse and edit the files of the folder a session works in. */
export function FilesPane({ session }: { session: SessionView }) {
  const cwd = session.cwd
  const epoch = useHostStore((s) => s.epoch)
  const connected = useHostStore((s) => s.connection === 'connected')
  const folder = useFiles((s) => s.byCwd[cwd] ?? EMPTY_FOLDER)
  const { loadDir, collapseAll, changed, create } = useFiles.getState()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<string[] | null>(null)
  const [creating, setCreating] = useState<'file' | 'dir' | null>(null)
  const [error, setError] = useState<string>()

  // Load the root, and keep listings and open files in step with the disk while the pane is open.
  useEffect(() => {
    if (!connected) return
    void loadDir(cwd, '').catch((err: unknown) =>
      setError(err instanceof Error ? err.message : String(err)),
    )
    sendHostFrame({ t: 'fs.watch', cwd })
    const stop = onHostFrame((frame) => {
      if (frame.t === 'fs.changed' && frame.cwd === cwd) changed(cwd, frame.paths)
    })
    return () => {
      stop()
      sendHostFrame({ t: 'fs.unwatch', cwd })
    }
  }, [cwd, epoch, connected, loadDir, changed])

  // Search as you type, ignoring answers that arrive out of order.
  useEffect(() => {
    if (!query.trim()) {
      setResults(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      hostRequest('files.search', { cwd, query }).then(
        (r) => !cancelled && setResults(r.paths),
        () => !cancelled && setResults([]),
      )
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [cwd, query])

  const active = folder.active ? folder.docs[folder.active] : undefined
  const name = cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd

  return (
    <div className="pane-body files">
      <div className="files-tree">
        <div className="pane-head">
          <h2>Files</h2>
          <span className="muted">{name}</span>
          <span className="spacer" />
          <button className="icon-btn" aria-label="New file" onClick={() => setCreating('file')}>
            <FilePlus size={18} />
          </button>
          <button className="icon-btn" aria-label="New folder" onClick={() => setCreating('dir')}>
            <FolderPlus size={18} />
          </button>
          <button className="icon-btn" aria-label="Collapse all" onClick={() => collapseAll(cwd)}>
            <ChevronsDownUp size={18} />
          </button>
        </div>
        <div className="search-box">
          <Search size={15} />
          <input
            placeholder="Search files"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button aria-label="Clear search" onClick={() => setQuery('')}>
              <X size={14} />
            </button>
          )}
        </div>
        {creating && (
          <NewEntry
            type={creating}
            onCancel={() => setCreating(null)}
            onCreate={async (path) => {
              try {
                await create(cwd, path, creating)
                setCreating(null)
                setError(undefined)
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
              }
            }}
          />
        )}
        {error && <div className="composer-error pane-error">{error}</div>}
        <div className="tree-scroll">
          {results ? (
            results.length === 0 ? (
              <div className="muted tree-note">No files match.</div>
            ) : (
              results.map((path) => (
                <button
                  key={path}
                  className="tree-row file"
                  onClick={() => void useFiles.getState().open(cwd, path)}
                >
                  <File size={16} />
                  <span className="tree-name">{baseName(path)}</span>
                  <span className="muted tree-dir">
                    {path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}
                  </span>
                </button>
              ))
            )
          ) : (
            <FileTree cwd={cwd} />
          )}
        </div>
        <div className="pane-foot">
          <span>{folder.active ?? ''}</span>
          <span>{active && !active.error ? formatBytes(active.size) : ''}</span>
        </div>
      </div>

      {folder.tabs.length > 0 && <EditorColumn cwd={cwd} />}
    </div>
  )
}

function NewEntry({
  type,
  onCreate,
  onCancel,
}: {
  type: 'file' | 'dir'
  onCreate(path: string): Promise<void>
  onCancel(): void
}) {
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => input.current?.focus(), [])
  return (
    <div className="new-entry">
      <input
        ref={input}
        placeholder={type === 'file' ? 'path/to/new-file.ts' : 'path/to/new-folder'}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel()
          if (e.key === 'Enter' && e.currentTarget.value.trim()) {
            void onCreate(e.currentTarget.value.trim().replace(/\\/g, '/'))
          }
        }}
        onBlur={onCancel}
      />
    </div>
  )
}

function EditorColumn({ cwd }: { cwd: string }) {
  const folder = useFiles((s) => s.byCwd[cwd] ?? EMPTY_FOLDER)
  const { activate, close, setDirty, save, reload } = useFiles.getState()
  const [position, setPosition] = useState<EditorPosition>({ line: 1, col: 1 })
  const [saveError, setSaveError] = useState<string>()
  const doc = folder.active ? folder.docs[folder.active] : undefined
  // Reads the text the editor currently holds, for the Save and Overwrite buttons.
  const textRef = useRef<(() => string) | null>(null)
  const liveText = () => textRef.current?.() ?? ''

  useEffect(() => setSaveError(undefined), [folder.active])

  if (!doc) return null
  const crumbs = doc.path.split('/')
  const doSave = async (text: string, force = false) => {
    setSaveError(undefined)
    try {
      await save(cwd, doc.path, text, force)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="editor-col">
      <div className="editor-tabs" role="tablist">
        {folder.tabs.map((path) => {
          const d = folder.docs[path]
          return (
            <div
              key={path}
              className="editor-tab"
              aria-selected={path === folder.active}
              role="tab"
            >
              <button onClick={() => activate(cwd, path)} title={path}>
                {baseName(path)}
              </button>
              <button
                aria-label={
                  d?.dirty
                    ? `${baseName(path)} has unsaved changes; close`
                    : `Close ${baseName(path)}`
                }
                onClick={() => {
                  if (
                    d?.dirty &&
                    !window.confirm(`${baseName(path)} has unsaved changes. Close it anyway?`)
                  )
                    return
                  close(cwd, path)
                }}
              >
                {d?.dirty ? <span className="dirty-dot" /> : <X size={13} />}
              </button>
            </div>
          )
        })}
      </div>

      <div className="breadcrumb">
        {crumbs.map((c, i) => (
          <span key={i} className={i === crumbs.length - 1 ? 'current' : ''}>
            {c}
            {i < crumbs.length - 1 && <span className="sep-chev">›</span>}
          </span>
        ))}
        <span className="spacer" />
        {!doc.binary && !doc.tooLarge && !doc.error && (
          <button
            className="save-btn"
            disabled={!doc.dirty}
            onClick={() => void doSave(liveText())}
          >
            Save
          </button>
        )}
      </div>

      {doc.conflict && (
        <div className="banner">
          <span>This file changed on disk{doc.dirty ? ' and you have unsaved edits' : ''}.</span>
          <button onClick={() => void reload(cwd, doc.path)}>Load from disk</button>
          <button onClick={() => void doSave(liveText(), true)}>Overwrite</button>
        </div>
      )}
      {saveError && !doc.conflict && <div className="banner error">{saveError}</div>}

      {doc.error ? (
        <div className="pane-empty">
          <h3>Can&apos;t open this file</h3>
          <p>{doc.error}</p>
        </div>
      ) : doc.binary ? (
        <div className="pane-empty">
          <span className="empty-icon">
            <FolderOpen size={26} />
          </span>
          <h3>Binary file</h3>
          <p>{formatBytes(doc.size)} · no preview.</p>
        </div>
      ) : doc.tooLarge ? (
        <div className="pane-empty">
          <h3>File is too large to edit</h3>
          <p>{formatBytes(doc.size)} is over the 2 MB editor limit.</p>
        </div>
      ) : (
        <Editor
          docKey={`${cwd}::${doc.path}`}
          fileName={baseName(doc.path)}
          content={doc.content}
          version={doc.version}
          onDirty={(dirty) => setDirty(cwd, doc.path, dirty)}
          onSave={(text) => void doSave(text)}
          textRef={textRef}
          onCursor={setPosition}
        />
      )}

      <div className="pane-foot">
        <span>
          Ln {position.line}, Col {position.col} · Spaces: 2 · {languageName(doc.path)} · UTF-8
        </span>
        <span>{doc.dirty ? '● 1 unsaved change · Ctrl S to save' : ''}</span>
      </div>
    </div>
  )
}
