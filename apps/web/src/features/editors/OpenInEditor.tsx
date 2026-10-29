import { Check, Code2, FolderOpen } from 'lucide-react'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { openInEditor, useEditors, useOpenError } from './editors.ts'

/**
 * "Open in" for the thread header: the session's folder in an installed editor or the file
 * manager (adapted from T3 Code's editor launcher). Shown only on the host machine itself, since
 * the editor opens on that machine's screen.
 */
export function OpenInEditor({ hostKey, cwd }: { hostKey: string; cwd: string }) {
  const { editors, canOpen, preferredId } = useEditors(hostKey)
  const [error, setError] = useOpenError()
  if (!canOpen || editors.length === 0) return null
  const open = (id: string) =>
    openInEditor(hostKey, id, { cwd }).catch((err: unknown) =>
      setError(err instanceof Error ? err.message : 'Could not open the editor'),
    )
  return (
    <Dropdown
      placement="bottom"
      align="end"
      trigger={({ toggle, open: expanded }) => (
        <button
          className="icon-btn"
          aria-label="Open in editor"
          title={error ?? 'Open the folder in an editor'}
          aria-expanded={expanded}
          onClick={toggle}
        >
          <Code2 size={17} />
        </button>
      )}
    >
      {(close) => (
        <>
          <div className="menu-label">Open folder in</div>
          {editors.map((editor) => (
            <button
              key={editor.id}
              className="menu-row editor-menu-row"
              onClick={() => {
                close()
                void open(editor.id)
              }}
            >
              {editor.id === 'file-manager' ? <FolderOpen size={15} /> : <Code2 size={15} />}
              <span className="menu-title">{editor.label}</span>
              {editor.id === preferredId && <Check size={14} className="menu-check" />}
            </button>
          ))}
        </>
      )}
    </Dropdown>
  )
}

/**
 * One button for the file open in the Files pane: opens it in the preferred editor at the cursor's
 * line and column (T3 Code's `path:line:col` targets).
 */
export function OpenFileInEditor({
  hostKey,
  cwd,
  path,
  line,
  column,
}: {
  hostKey: string
  cwd: string
  path: string
  line?: number
  column?: number
}) {
  const { editors, canOpen, preferredId } = useEditors(hostKey)
  const [error, setError] = useOpenError()
  const editor =
    editors.find((e) => e.id === preferredId && e.id !== 'file-manager') ??
    editors.find((e) => e.id !== 'file-manager')
  if (!canOpen || !editor) return null
  return (
    <button
      className="icon-btn"
      aria-label={`Open ${path} in ${editor.label}`}
      title={error ?? `Open in ${editor.label}${line ? ` at line ${line}` : ''}`}
      onClick={() =>
        void openInEditor(hostKey, editor.id, { cwd, path, line, column }).catch((err: unknown) =>
          setError(err instanceof Error ? err.message : 'Could not open the editor'),
        )
      }
    >
      <Code2 size={15} />
    </button>
  )
}
