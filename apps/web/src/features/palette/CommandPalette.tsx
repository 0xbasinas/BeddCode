// Command palette. The interaction (one input over actions, sessions and projects, ranked as you
// type) follows T3 Code's command palette (MIT, Copyright (c) 2026 T3 Tools Inc.); the ranking
// is adapted from its search ranking, see packages/client-runtime/src/commandRanking.ts and
// THIRD_PARTY_NOTICES.md.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useNavigate, useRouterState } from '@tanstack/react-router'
import { create } from 'zustand'
import {
  CalendarClock,
  Copy,
  FolderOpen,
  FolderPlus,
  GitBranch,
  Globe,
  MessageSquare,
  PanelRight,
  Pin,
  Plus,
  Search,
  Settings,
  Keyboard,
  Palette,
  SquareTerminal,
  CircleStop,
  Files,
} from 'lucide-react'
import { rankCommands } from '@beddcode/client-runtime'
import {
  interrupt,
  setSessionPinned,
  useAllSessions,
  useHostStore,
  useSession,
  useSessionHostKey,
} from '../../stores/host.ts'
import { useUiStore, type PaneId } from '../../stores/ui.ts'
import { chooseFolder, useFolderFlow } from '../folders/folderFlow.ts'
import { EditorIcon } from '../editors/EditorIcon.tsx'
import { openInEditor, useEditors } from '../editors/editors.ts'

export const usePalette = create<{ open: boolean; setOpen(open: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}))

interface Command {
  id: string
  label: string
  group: 'Action' | 'Session' | 'Project' | 'This session'
  icon: ReactNode
  keywords?: string[]
  detail?: string
  bias?: number
  run(): void
}

const PANES: { id: PaneId; label: string; icon: ReactNode; keywords: string[] }[] = [
  {
    id: 'git',
    label: 'Git',
    icon: <GitBranch size={15} />,
    keywords: ['changes', 'diff', 'commit', 'review'],
  },
  {
    id: 'files',
    label: 'Files',
    icon: <Files size={15} />,
    keywords: ['explorer', 'editor', 'tree'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    icon: <SquareTerminal size={15} />,
    keywords: ['shell', 'console'],
  },
  { id: 'browser', label: 'Browser', icon: <Globe size={15} />, keywords: ['preview', 'web'] },
]

const activeSessionId = (path: string) => /^\/session\/([^/]+)/.exec(path)?.[1]

/** Ctrl/Cmd+Shift+P: every action, session and project behind one search box. */
export function CommandPalette() {
  const open = usePalette((s) => s.open)
  if (!open) return null
  return <PaletteDialog />
}

function PaletteDialog() {
  const setOpen = usePalette((s) => s.setOpen)
  const navigate = useNavigate()
  const path = useRouterState({ select: (s) => s.location.pathname })
  const sessionId = activeSessionId(path)
  const session = useSession(sessionId)
  const hostKey = useSessionHostKey(sessionId)
  const sessions = useAllSessions()
  const entries = useHostStore((s) => s.entries)
  const runtimes = useHostStore((s) => s.runtimes)
  const editors = useEditors(hostKey ?? '')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState(0)
  const list = useRef<HTMLDivElement>(null)
  const close = () => setOpen(false)

  const commands = useMemo<Command[]>(() => {
    const ui = useUiStore.getState()
    const out: Command[] = [
      {
        id: 'new',
        label: 'New session',
        group: 'Action',
        icon: <Plus size={15} />,
        keywords: ['chat', 'start', 'agent'],
        run: () => void navigate({ to: '/', search: { compose: true } }),
      },
      {
        id: 'search',
        label: 'Search sessions',
        group: 'Action',
        icon: <Search size={15} />,
        keywords: ['find', 'messages'],
        detail: 'Ctrl+K',
        run: () => ui.setSearchOpen(true),
      },
      {
        id: 'add-folder',
        label: 'Add folder…',
        group: 'Action',
        icon: <FolderPlus size={15} />,
        keywords: ['project', 'open', 'repository'],
        detail: 'Ctrl+O',
        run: () => void chooseFolder(useFolderFlow.getState().menuHostKey),
      },
      ...PANES.map((p): Command => ({
        id: `pane-${p.id}`,
        label: `Show ${p.label}`,
        group: 'Action',
        icon: p.icon,
        keywords: ['pane', 'panel', ...p.keywords],
        run: () => ui.openPane(p.id),
      })),
      {
        id: 'pane-toggle',
        label: 'Collapse or expand the right pane',
        group: 'Action',
        icon: <PanelRight size={15} />,
        keywords: ['panel', 'hide', 'sidebar'],
        detail: 'Ctrl+Alt+B',
        run: () => ui.togglePaneCollapsed(),
      },
      {
        id: 'schedules',
        label: 'Open schedules',
        group: 'Action',
        icon: <CalendarClock size={15} />,
        keywords: ['cron', 'automation', 'routines'],
        run: () => void navigate({ to: '/schedules' }),
      },
      {
        id: 'design',
        label: 'Open Design',
        group: 'Action',
        icon: <Palette size={15} />,
        keywords: ['canvas', 'mockup'],
        run: () => void navigate({ to: '/design' }),
      },
      {
        id: 'settings',
        label: 'Open settings',
        group: 'Action',
        icon: <Settings size={15} />,
        keywords: ['preferences', 'options', 'agents'],
        run: () => void navigate({ to: '/settings' }),
      },
      {
        id: 'shortcuts',
        label: 'Keyboard shortcuts',
        group: 'Action',
        icon: <Keyboard size={15} />,
        keywords: ['keys', 'hotkeys'],
        run: () => void navigate({ to: '/settings', search: { section: 'shortcuts' } }),
      },
    ]
    if (session && sessionId && hostKey) {
      const target = { cwd: session.cwd }
      if (editors.canOpen)
        for (const editor of editors.editors)
          out.push({
            id: `editor-${editor.id}`,
            label:
              editor.id === 'file-manager'
                ? 'Reveal folder in the file manager'
                : `Open folder in ${editor.label}`,
            group: 'This session',
            icon: <EditorIcon id={editor.id} platform={editors.platform} size={15} />,
            keywords: ['editor', 'ide', 'open in', 'code'],
            bias: editor.id === editors.preferredId ? -5 : 0,
            run: () => void openInEditor(hostKey, editor.id, target).catch(() => {}),
          })
      out.push(
        {
          id: 'copy-path',
          label: 'Copy folder path',
          group: 'This session',
          icon: <Copy size={15} />,
          keywords: ['cwd', 'directory', 'clipboard'],
          run: () => void navigator.clipboard?.writeText(session.cwd),
        },
        {
          id: 'pin',
          label: session.pinned ? 'Unpin session' : 'Pin session to top',
          group: 'This session',
          icon: <Pin size={15} />,
          run: () => void setSessionPinned(sessionId, !session.pinned),
        },
        {
          id: 'new-here',
          label: 'New session in this folder',
          group: 'This session',
          icon: <Plus size={15} />,
          keywords: ['project'],
          run: () =>
            void navigate({ to: '/', search: { host: hostKey, project: session.projectPath } }),
        },
      )
      if (session.status === 'running' || session.status === 'needs-you')
        out.push({
          id: 'stop',
          label: 'Stop the agent',
          group: 'This session',
          icon: <CircleStop size={15} />,
          keywords: ['interrupt', 'cancel'],
          run: () => void interrupt(sessionId),
        })
    }
    const multiHost = entries.length > 1
    for (const entry of entries) {
      for (const project of runtimes[entry.key]?.projects ?? [])
        out.push({
          id: `project-${entry.key}-${project.path}`,
          label: `New session in ${project.name}`,
          group: 'Project',
          icon: <FolderOpen size={15} />,
          keywords: [project.path, ...(multiHost ? [entry.name] : [])],
          detail: multiHost ? entry.name : undefined,
          bias: 30,
          run: () => void navigate({ to: '/', search: { host: entry.key, project: project.path } }),
        })
    }
    const hostName = new Map(entries.map((e) => [e.key, e.name]))
    for (const { hostKey: key, session: s } of sessions) {
      if (s.id === sessionId) continue
      const folder = s.projectPath.split(/[\\/]/).filter(Boolean).at(-1) ?? s.projectPath
      out.push({
        id: `session-${s.id}`,
        label: s.title || 'Untitled session',
        group: 'Session',
        icon: <MessageSquare size={15} />,
        keywords: [folder, s.branch ?? '', ...(multiHost ? [hostName.get(key) ?? ''] : [])].filter(
          Boolean,
        ),
        detail: multiHost ? `${folder} · ${hostName.get(key)}` : folder,
        bias: 40,
        run: () => void navigate({ to: '/session/$sessionId', params: { sessionId: s.id } }),
      })
    }
    return out
  }, [navigate, session, sessionId, hostKey, editors, entries, runtimes, sessions])

  const shown = useMemo(() => rankCommands(commands, query, 60), [commands, query])
  useEffect(() => setSelected(0), [query])
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selected])

  const run = (command: Command | undefined) => {
    if (!command) return
    close()
    command.run()
  }

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="palette-input">
          <Search size={16} />
          <input
            autoFocus
            value={query}
            placeholder="Type a command, session or folder…"
            aria-label="Search commands"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                close()
              } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelected((i) => Math.min(shown.length - 1, i + 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelected((i) => Math.max(0, i - 1))
              } else if (e.key === 'Enter') {
                e.preventDefault()
                run(shown[selected])
              }
            }}
          />
          <kbd>Esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={list}>
          {shown.length === 0 && <div className="palette-empty muted">Nothing matches.</div>}
          {shown.map((command, i) => (
            <button
              key={command.id}
              role="option"
              aria-selected={i === selected}
              className="palette-row"
              onMouseMove={() => setSelected(i)}
              onClick={() => run(command)}
            >
              <span className="palette-icon">{command.icon}</span>
              <span className="palette-label">{command.label}</span>
              {command.detail && <span className="palette-detail">{command.detail}</span>}
              <span className="palette-group">{command.group}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
