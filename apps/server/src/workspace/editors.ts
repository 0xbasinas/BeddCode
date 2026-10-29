// Editor table and launch arguments adapted from T3 Code
// (https://github.com/pingdotgg/t3code: packages/contracts/src/editor.ts,
// packages/shared/src/editor.ts, apps/server/src/process/externalLauncher.ts).
// MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
// Changes for BeddCode: plain Node instead of Effect, BeddCode's PATH/PATHEXT lookup, a folder
// opens alongside the file, a smaller set of install locations, and no remote (SSH) URLs.
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { resolveExecutable } from '@beddcode/shared'

type LaunchStyle = 'goto' | 'line-column' | 'direct-path'

interface EditorDefinition {
  id: string
  label: string
  /** Executables tried in order; null for the system file manager. */
  commands: readonly string[] | null
  baseArgs?: readonly string[]
  launchStyle: LaunchStyle
  /** Install folder names when they differ from the label (Windows/macOS lookups). */
  installNames?: readonly string[]
}

export const EDITORS: readonly EditorDefinition[] = [
  // `--classic` keeps file opens in the IDE even when Cursor's Agents window is in front.
  {
    id: 'cursor',
    label: 'Cursor',
    commands: ['cursor'],
    baseArgs: ['--classic'],
    launchStyle: 'goto',
  },
  {
    id: 'vscode',
    label: 'VS Code',
    commands: ['code'],
    launchStyle: 'goto',
    installNames: ['Microsoft VS Code', 'Visual Studio Code'],
  },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    commands: ['code-insiders'],
    launchStyle: 'goto',
    installNames: ['Microsoft VS Code Insiders', 'Visual Studio Code - Insiders'],
  },
  { id: 'vscodium', label: 'VSCodium', commands: ['codium'], launchStyle: 'goto' },
  { id: 'windsurf', label: 'Windsurf', commands: ['windsurf'], launchStyle: 'goto' },
  { id: 'trae', label: 'Trae', commands: ['trae'], launchStyle: 'goto' },
  { id: 'kiro', label: 'Kiro', commands: ['kiro'], launchStyle: 'goto' },
  { id: 'zed', label: 'Zed', commands: ['zed', 'zeditor'], launchStyle: 'direct-path' },
  {
    id: 'idea',
    label: 'IntelliJ IDEA',
    commands: ['idea'],
    launchStyle: 'line-column',
    installNames: ['IntelliJ IDEA', 'IntelliJ IDEA CE', 'IntelliJ IDEA Ultimate'],
  },
  { id: 'webstorm', label: 'WebStorm', commands: ['webstorm'], launchStyle: 'line-column' },
  {
    id: 'pycharm',
    label: 'PyCharm',
    commands: ['pycharm'],
    launchStyle: 'line-column',
    installNames: ['PyCharm', 'PyCharm CE'],
  },
  { id: 'goland', label: 'GoLand', commands: ['goland'], launchStyle: 'line-column' },
  {
    id: 'rider',
    label: 'Rider',
    commands: ['rider'],
    launchStyle: 'line-column',
    installNames: ['Rider', 'JetBrains Rider'],
  },
  { id: 'clion', label: 'CLion', commands: ['clion'], launchStyle: 'line-column' },
  { id: 'phpstorm', label: 'PhpStorm', commands: ['phpstorm'], launchStyle: 'line-column' },
  { id: 'rubymine', label: 'RubyMine', commands: ['rubymine'], launchStyle: 'line-column' },
  { id: 'rustrover', label: 'RustRover', commands: ['rustrover'], launchStyle: 'line-column' },
  { id: 'file-manager', label: 'File manager', commands: null, launchStyle: 'direct-path' },
]

export interface DetectedEditor {
  id: string
  label: string
  command: string
  baseArgs: readonly string[]
  launchStyle: LaunchStyle
}

export interface EditorPlatform {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  /** True when the path is an executable file; swapped out in tests. */
  isFile?: (p: string) => boolean
}

const defaultIsFile = (p: string) => {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

/** Install locations outside PATH, where GUI installers usually leave the CLI. */
function installCandidates(editor: EditorDefinition, { platform, env }: EditorPlatform): string[] {
  const command = editor.commands?.[0]
  if (!command) return []
  const names = editor.installNames ?? [editor.label]
  const jetbrains = editor.launchStyle === 'line-column'
  const home = env.HOME ?? env.USERPROFILE
  const out: string[] = []
  if (platform === 'darwin') {
    for (const root of [...(home ? [path.join(home, 'Applications')] : []), '/Applications']) {
      for (const name of names) {
        const contents = path.join(root, `${name}.app`, 'Contents')
        if (jetbrains) out.push(path.join(contents, 'MacOS', command))
        else if (editor.id === 'zed') out.push(path.join(contents, 'MacOS', 'cli'))
        else
          out.push(
            path.join(contents, 'Resources/app/bin', command),
            path.join(contents, 'Resources/app/bin/code'),
          )
      }
    }
    if (home && jetbrains)
      out.push(path.join(home, 'Library/Application Support/JetBrains/Toolbox/scripts', command))
  } else if (platform === 'win32') {
    const roots = [
      ...(env.LOCALAPPDATA ? [path.join(env.LOCALAPPDATA, 'Programs')] : []),
      ...[env.ProgramFiles, env['ProgramFiles(x86)']].filter((r): r is string => !!r),
    ]
    if (jetbrains) {
      if (env.LOCALAPPDATA)
        out.push(path.join(env.LOCALAPPDATA, 'JetBrains/Toolbox/scripts', `${command}.cmd`))
    } else {
      for (const root of roots) {
        for (const name of names) {
          out.push(
            path.join(root, name, 'resources/app/bin', `${command}.cmd`),
            path.join(root, name, 'bin', `${command}.cmd`),
          )
          if (editor.id === 'zed')
            out.push(path.join(root, name, 'bin', 'zed.exe'), path.join(root, name, 'zed.exe'))
        }
      }
    }
  } else {
    const dirs = [
      ...(home ? [path.join(home, '.local/bin')] : []),
      '/usr/local/bin',
      '/usr/bin',
      '/snap/bin',
    ]
    if (jetbrains && home)
      dirs.push(
        path.join(
          env.XDG_DATA_HOME || path.join(home, '.local/share'),
          'JetBrains/Toolbox/scripts',
        ),
      )
    for (const dir of dirs) for (const name of editor.commands ?? []) out.push(path.join(dir, name))
  }
  return out
}

function fileManagerCommand({ platform, env }: EditorPlatform): string | undefined {
  if (platform === 'darwin') return 'open'
  if (platform === 'win32') return 'explorer.exe'
  // xdg-open without a desktop session has nothing to open the folder in.
  const graphical = [env.DISPLAY, env.WAYLAND_DISPLAY].some((v) => v && v.trim() !== '')
  return graphical ? 'xdg-open' : undefined
}

/** Editors installed on this machine, in table order (preferred first). */
export function detectEditors(
  host: EditorPlatform = { platform: process.platform, env: process.env },
): DetectedEditor[] {
  const isFile = host.isFile ?? defaultIsFile
  const found: DetectedEditor[] = []
  for (const editor of EDITORS) {
    let command: string | null | undefined
    if (editor.commands === null) {
      const fm = fileManagerCommand(host)
      command = fm && (host.platform === 'win32' ? fm : resolveOn(fm, host, isFile))
    } else {
      for (const name of editor.commands) {
        command = resolveOn(name, host, isFile)
        if (command) break
      }
      command ??= installCandidates(editor, host).find(isFile)
    }
    if (command)
      found.push({
        id: editor.id,
        label: editor.label,
        command,
        baseArgs: editor.baseArgs ?? [],
        launchStyle: editor.launchStyle,
      })
  }
  return found
}

function resolveOn(
  name: string,
  host: EditorPlatform,
  isFile: (p: string) => boolean,
): string | null {
  // resolveExecutable uses the real file system; tests inject their own lookup.
  if (host.isFile) {
    const dirs = (host.env.PATH ?? '').split(host.platform === 'win32' ? ';' : ':').filter(Boolean)
    const exts = host.platform === 'win32' ? ['.exe', '.cmd', '.bat'] : ['']
    for (const dir of dirs)
      for (const ext of exts) {
        const p = path.join(dir, name + ext)
        if (isFile(p)) return p
      }
    return null
  }
  return resolveExecutable(name, host.env)
}

export interface OpenTarget {
  /** The project folder; opened as the editor's workspace. */
  cwd: string
  /** A file inside it, absolute or relative to `cwd`. */
  path?: string
  line?: number
  column?: number
}

/** Command-line arguments that open the folder, and the file at a line when given. */
export function editorArgs(
  editor: Pick<DetectedEditor, 'id' | 'baseArgs' | 'launchStyle'>,
  target: OpenTarget,
): string[] {
  const file = target.path ? path.resolve(target.cwd, target.path) : undefined
  if (editor.id === 'file-manager') return [file ? path.dirname(file) : target.cwd]
  const base = [...editor.baseArgs]
  if (!file) return [...base, target.cwd]
  const line = target.line && target.line > 0 ? Math.floor(target.line) : undefined
  const column = line && target.column && target.column > 0 ? Math.floor(target.column) : undefined
  const position = line ? `${file}:${line}${column ? `:${column}` : ''}` : file
  switch (editor.launchStyle) {
    case 'goto':
      return [...base, target.cwd, ...(line ? ['--goto', position] : [file])]
    case 'direct-path':
      return [...base, target.cwd, position]
    case 'line-column':
      // JetBrains counts `--column` from 0; positions here count from 1.
      return [
        ...base,
        ...(line ? ['--line', String(line)] : []),
        ...(column ? ['--column', String(column - 1)] : []),
        file,
      ]
  }
}

/** Characters cmd.exe would reinterpret inside a `.cmd` shim's arguments. */
// oxlint-disable-next-line no-control-regex -- control characters are exactly what is refused
const UNSAFE_SHIM_ARG = /[\u0000-\u001f\u007f"%!]/

/** Starts the editor detached, so it outlives the host and does not hold its stdio. */
export function launchEditor(
  editor: DetectedEditor,
  target: OpenTarget,
  platform = process.platform,
): void {
  const args = editorArgs(editor, target)
  const shim = platform === 'win32' && /\.(cmd|bat)$/i.test(editor.command)
  if (shim && args.some((a) => UNSAFE_SHIM_ARG.test(a)))
    throw new Error('That path has characters the editor launcher cannot pass safely')
  const quote = (a: string) => (/[\s&|<>^()]/.test(a) ? `"${a}"` : a)
  const child = shim
    ? spawn('cmd.exe', ['/d', '/s', '/c', `"${[editor.command, ...args].map(quote).join(' ')}"`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        windowsVerbatimArguments: true,
      })
    : spawn(editor.command, args, { detached: true, stdio: 'ignore', windowsHide: true })
  child.on('error', () => {})
  child.unref()
}
