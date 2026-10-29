import { paneProject } from '../shell/paneProject.ts'
import { useEffect, useRef, useState } from 'react'
import {
  File,
  FilePlus,
  FolderOpen,
  FolderPlus,
  Search,
  X,
  ChevronsDownUp,
  Paperclip,
} from 'lucide-react'
import type { PaneWorkspace } from '../../stores/composerWorkspace.ts'
import { hostRequest, onHostFrame, sendHostFrame, useRuntime } from '../../stores/host.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { formatBytes } from '../../ui/format.ts'
import { MediaViewer } from './MediaViewer.tsx'
import { Editor, type EditorPosition } from './Editor.tsx'
import { FileTree } from './FileTree.tsx'
import { baseName, languageName } from './fileIcons.ts'
import { EMPTY_FOLDER, folderId, useFiles } from './filesStore.ts'
import { useAppPreferences } from '../../stores/appPreferences.ts'
import { attachWorkspaceFile } from '../composer/attachments.ts'
import { FileRow } from './FileRow.tsx'

/** Browse and edit the selected working folder, including before a session starts. */
export function FilesPane({ workspace }: { workspace: PaneWorkspace }) {
  const hostKey = useHostKey()
  const realCwd = workspace.cwd
  // Open files and listings are kept per folder *and* host: two hosts can have the same path.
  const cwd = folderId(hostKey, realCwd)
  const { epoch, connection } = useRuntime(hostKey)
  const connected = connection === 'connected'
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
    sendHostFrame(hostKey, { t: 'fs.watch', cwd: realCwd })
    const stop = onHostFrame(hostKey, (frame) => {
      if (frame.t === 'fs.changed' && frame.cwd === realCwd) changed(cwd, frame.paths)
    })
    return () => {
      stop()
      sendHostFrame(hostKey, { t: 'fs.unwatch', cwd: realCwd })
    }
  }, [hostKey, realCwd, cwd, epoch, connected, loadDir, changed])

  // Search as you type, ignoring answers that arrive out of order.
  useEffect(() => {
    if (!query.trim()) {
      setResults(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      hostRequest(hostKey, 'files.search', { cwd: realCwd, query }).then(
        (r) => !cancelled && setResults(r.paths),
        () => !cancelled && setResults([]),
      )
    }, 150)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [hostKey, realCwd, query])

  const active = folder.active ? folder.docs[folder.active] : undefined
  const project = paneProject(workspace)
  const attach = (path: string) =>
    void attachWorkspaceFile(hostKey, workspace.draftId, realCwd, path)

  return (
    <div className="pane-body files">
      <div className="files-tree">
        <div className="pane-head">
          <h2>Files</h2>
          <span className="muted pane-project" title={project.title}>
            {project.label}
          </span>
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
                <FileRow
                  key={path}
                  path={path}
                  onOpen={() => void useFiles.getState().open(cwd, path)}
                  onAttach={() => attach(path)}
                >
                  <File size={16} />
                  <span className="tree-name">{baseName(path)}</span>
                  <span className="muted tree-dir">
                    {path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : ''}
                  </span>
                </FileRow>
              ))
            )
          ) : (
            <FileTree cwd={cwd} onAttach={attach} />
          )}
        </div>
        <div className="pane-foot">
          <span>{folder.active ?? ''}</span>
          <span>
            {active && !active.error
              ? `${formatBytes(active.size)} · ${active.content.split('\n').length} lines`
              : ''}
          </span>
        </div>
      </div>

      {folder.tabs.length > 0 && <EditorColumn cwd={cwd} onAttach={attach} />}
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

function EditorColumn({ cwd, onAttach }: { cwd: string; onAttach(path: string): void }) {
  const tabSize = useAppPreferences((s) => s.values.editorTabSize)
  const folder = useFiles((s) => s.byCwd[cwd] ?? EMPTY_FOLDER)
  const { activate, close, setDraft, save, reload } = useFiles.getState()
  const [position, setPosition] = useState<EditorPosition>({ line: 1, col: 1 })
  const [saveError, setSaveError] = useState<string>()
  const [mediaInfo, setMediaInfo] = useState('')
  const doc = folder.active ? folder.docs[folder.active] : undefined
  // Reads the text the editor currently holds, for the Save and Overwrite buttons.
  const textRef = useRef<(() => string) | null>(null)
  const liveText = () => textRef.current?.() ?? ''

  useEffect(() => setSaveError(undefined), [folder.active])

  // Many tabs scroll sideways: the wheel scrolls them, and the open one is always brought into view.
  const tabsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const strip = tabsRef.current
    if (!strip) return
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX !== 0 || strip.scrollWidth <= strip.clientWidth) return
      strip.scrollLeft += e.deltaY
      e.preventDefault()
    }
    strip.addEventListener('wheel', onWheel, { passive: false })
    return () => strip.removeEventListener('wheel', onWheel)
  }, [])
  useEffect(() => {
    tabsRef.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [folder.active, folder.tabs.length])

  if (!doc) return null
  const crumbs = doc.path.split('/')
  const closeTab = (path: string) => {
    if (
      folder.docs[path]?.dirty &&
      !window.confirm(`${baseName(path)} has unsaved changes. Close it anyway?`)
    )
      return
    close(cwd, path)
  }
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
      <div className="editor-tabs" role="tablist" ref={tabsRef}>
        {folder.tabs.map((path) => {
          const d = folder.docs[path]
          return (
            <div
              key={path}
              className="editor-tab"
              aria-selected={path === folder.active}
              role="tab"
              // Middle-click closes a tab, as in a browser.
              onAuxClick={(e) => {
                if (e.button === 1) closeTab(path)
              }}
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
                onClick={() => closeTab(path)}
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
        <button
          className="icon-btn"
          aria-label={`Attach ${doc.path}`}
          title="Attach saved file to message"
          onClick={() => onAttach(doc.path)}
        >
          <Paperclip size={15} />
        </button>
        {!doc.binary && !doc.tooLarge && !doc.error && !doc.media && (
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
      ) : doc.media ? (
        <MediaViewer
          cwd={cwd}
          path={doc.path}
          kind={doc.media}
          version={doc.version}
          onInfo={setMediaInfo}
        />
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
          content={doc.draft ?? doc.content}
          version={doc.version}
          onChange={(text) => setDraft(cwd, doc.path, text)}
          onSave={(text) => void doSave(text)}
          textRef={textRef}
          onCursor={setPosition}
        />
      )}

      <div className="pane-foot">
        {doc.media ? (
          <span>{mediaInfo}</span>
        ) : (
          <span>
            Ln {position.line}, Col {position.col} · Spaces: {tabSize} · {languageName(doc.path)} ·
            UTF-8
          </span>
        )}
        <span>{doc.dirty ? '● 1 unsaved change · Ctrl S to save' : ''}</span>
      </div>
    </div>
  )
}
