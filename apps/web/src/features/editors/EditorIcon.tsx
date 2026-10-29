import { Code2, FolderOpen } from 'lucide-react'
import { BrandIcon, type BrandId } from '../../ui/BrandIcon.tsx'

// Editor ids (from the host's editors.list) to their logos. VS Code Insiders shares VS Code's mark,
// and RustRover, which theSVG does not have, shows the JetBrains mark.
const EDITOR_BRANDS: Record<string, BrandId> = {
  cursor: 'cursor',
  vscode: 'vscode',
  'vscode-insiders': 'vscode',
  vscodium: 'vscodium',
  windsurf: 'windsurf',
  trae: 'trae',
  kiro: 'kiro',
  zed: 'zed',
  idea: 'idea',
  webstorm: 'webstorm',
  pycharm: 'pycharm',
  goland: 'goland',
  rider: 'rider',
  clion: 'clion',
  phpstorm: 'phpstorm',
  rubymine: 'rubymine',
  rustrover: 'jetbrains',
}

/** Which logo an editor gets; the file manager follows the host's system (Finder, Explorer). */
export function editorBrand(id: string, platform?: string): BrandId | undefined {
  if (id === 'file-manager')
    return platform === 'darwin' ? 'apple' : platform === 'win32' ? 'windows' : undefined
  return EDITOR_BRANDS[id]
}

/** An editor's logo, or a generic code/folder glyph for one without a mark. Decorative. */
export function EditorIcon({
  id,
  platform,
  size = 15,
}: {
  id: string
  platform?: string
  size?: number
}) {
  const brand = editorBrand(id, platform)
  if (brand) return <BrandIcon brand={brand} size={size} />
  return id === 'file-manager' ? <FolderOpen size={size} /> : <Code2 size={size} />
}
