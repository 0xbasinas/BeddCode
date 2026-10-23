import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import { EMPTY_FOLDER, useFiles } from './filesStore.ts'
import { FileIcon } from './FileIcon.tsx'
import { FileRow } from './FileRow.tsx'

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

/** Lazily loaded folder tree of one session folder. */
export function FileTree({ cwd, onAttach }: { cwd: string; onAttach(path: string): void }) {
  return <Level cwd={cwd} dir="" depth={0} onAttach={onAttach} />
}

function Level({
  cwd,
  dir,
  depth,
  onAttach,
}: {
  cwd: string
  dir: string
  depth: number
  onAttach(path: string): void
}) {
  const folder = useFiles((s) => s.byCwd[cwd] ?? EMPTY_FOLDER)
  const toggleDir = useFiles((s) => s.toggleDir)
  const open = useFiles((s) => s.open)
  const entries = folder.entries[dir]
  if (!entries) return depth === 0 ? <div className="muted tree-note">Loading…</div> : null
  if (entries.length === 0 && depth === 0)
    return <div className="muted tree-note">This folder is empty.</div>

  return (
    <>
      {entries.map((entry) => {
        const path = join(dir, entry.name)
        const pad = { paddingLeft: 8 + depth * 16 }
        if (entry.type === 'dir') {
          const expanded = folder.expanded[path]
          return (
            <div key={path}>
              <button
                className={`tree-row ${entry.ignored ? 'dim' : ''}`}
                style={pad}
                onClick={() => void toggleDir(cwd, path)}
                aria-expanded={Boolean(expanded)}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                {expanded ? <FolderOpen size={16} /> : <Folder size={16} />}
                <span className="tree-name">{entry.name}</span>
              </button>
              {expanded && <Level cwd={cwd} dir={path} depth={depth + 1} onAttach={onAttach} />}
            </div>
          )
        }
        return (
          <FileRow
            key={path}
            path={path}
            active={folder.active === path}
            style={{ ...pad, paddingLeft: 8 + depth * 16 + 18 }}
            onOpen={() => void open(cwd, path)}
            onAttach={() => onAttach(path)}
          >
            <FileIcon name={entry.name} />
            <span className="tree-name">{entry.name}</span>
          </FileRow>
        )
      })}
    </>
  )
}
