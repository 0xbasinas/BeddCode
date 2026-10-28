import { EXTENSIONS, FILE_NAMES, FOLDER_NAMES, ICONS } from './fileIconData.ts'

const urls = new Map<string, string>()
function iconUrl(id: string): string {
  let url = urls.get(id)
  if (!url) {
    url = `data:image/svg+xml,${encodeURIComponent(ICONS[id] ?? ICONS.file!)}`
    urls.set(id, url)
  }
  return url
}

/** The icon for a file: by its exact name first, then by the longest extension it ends with. */
export function fileIconId(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? name).toLowerCase()
  const named = FILE_NAMES[base]
  if (named) return named
  for (let dot = base.indexOf('.'); dot !== -1; dot = base.indexOf('.', dot + 1)) {
    const id = EXTENSIONS[base.slice(dot + 1)]
    if (id) return id
  }
  return 'file'
}

/** A folder's closed and open icons, by its name. */
export function folderIconIds(name: string): [string, string] {
  return FOLDER_NAMES[name.toLowerCase()] ?? ['folder', 'folder-open']
}

function Mark({ id, size }: { id: string; size: number }) {
  return (
    <img
      className="file-icon"
      src={iconUrl(id)}
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  )
}

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  return <Mark id={fileIconId(name)} size={size} />
}

export function FolderIcon({
  name,
  open,
  size = 16,
}: {
  name: string
  open?: boolean
  size?: number
}) {
  return <Mark id={folderIconIds(name)[open ? 1 : 0]} size={size} />
}
