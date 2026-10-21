import { File, FileCode, FileJson, FileText } from 'lucide-react'
import { fileLabel } from './fileIcons.ts'

export function FileIcon({ name, size = 16 }: { name: string; size?: number }) {
  const label = fileLabel(name)
  const Icon = /\.json$/i.test(name)
    ? FileJson
    : /\.(md|txt)$/i.test(name)
      ? FileText
      : /\.(html|xml|svg)$/i.test(name)
        ? FileCode
        : File
  return (
    <span className="file-icon" aria-hidden="true">
      <Icon size={size} />
      {label && !/^(md|json)$/i.test(label) && <span className="file-label">{label}</span>}
    </span>
  )
}
