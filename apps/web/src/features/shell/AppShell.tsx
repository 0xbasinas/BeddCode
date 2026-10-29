import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { startHosts } from '../../stores/host.ts'
// Runs agents' browser tool calls in the desktop app's browser pane.
import '../browser/browserAgent.ts'
import { startNotifications } from '../notifications/notifier.ts'
import { LeftRail } from './LeftRail.tsx'
import { RightRail } from './RightRail.tsx'
import { HostStatusBanner } from './HostStatusBanner.tsx'
import { WindowBar } from './WindowBar.tsx'
import { RAIL_WIDTH, openPaneWidth, rememberPaneWidth } from './paneWidth.ts'
import { Sidebar } from './Sidebar.tsx'
import { resolveTheme, useAppPreferences } from '../../stores/appPreferences.ts'
import { useUiStore } from '../../stores/ui.ts'
import { appWindowControls } from '../../ui/desktop.ts'
import { FolderBrowserLayer } from '../folders/FolderBrowserDialog.tsx'
import { FolderPickerHint, FolderToast } from '../folders/FolderToast.tsx'
import { chooseFolder, useFolderFlow } from '../folders/folderFlow.ts'

export function AppShell() {
  const rightPanel = usePanelRef()
  const layout = useDefaultLayout({ id: 'beddcode-shell', storage: layoutStorage() })
  // A pane that needs room (an open editor, the browser) asks for it; it never shrinks the panel.
  const wantWidth = useCallback(
    (px: number) => {
      const current = rightPanel.current?.getSize().inPixels ?? 0
      if (current < px) rightPanel.current?.resize(px)
    },
    [rightPanel],
  )
  useEffect(() => startHosts(), [])
  useEffect(() => startNotifications(), [])
  // With no pane open the right panel is just its icon rail, so the thread gets the room.
  const activePane = useUiStore((s) => s.activePane)
  // Collapsing or expanding slides quickly (CSS, off under reduced motion); dragging never does.
  const [sliding, setSliding] = useState(false)
  const slideTimer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => {
    const panel = rightPanel.current
    if (!panel) return
    const collapse = !activePane && !panel.isCollapsed()
    const expand = Boolean(activePane) && panel.isCollapsed()
    if (!collapse && !expand) return
    setSliding(true)
    clearTimeout(slideTimer.current)
    slideTimer.current = setTimeout(() => setSliding(false), 200)
    if (collapse) panel.collapse()
    else panel.resize(openPaneWidth(layoutStorage()))
  }, [activePane, rightPanel])
  useEffect(() => () => clearTimeout(slideTimer.current), [])
  // Remembers how wide an open pane was; dragging one shut closes it, so its rail button agrees.
  const onRightResize = useCallback(() => {
    const panel = rightPanel.current
    if (!panel) return
    if (!panel.isCollapsed()) return rememberPaneWidth(panel.getSize().inPixels, layoutStorage())
    if (useUiStore.getState().activePane) useUiStore.getState().collapsePane()
  }, [rightPanel])
  const preferences = useAppPreferences((s) => s.values)
  useEffect(() => {
    const root = document.documentElement
    root.dataset.desktop = window.beddcodeDesktop ? 'true' : 'false'
    if (window.beddcodeDesktop) root.dataset.platform = window.beddcodeDesktop.platform
    root.dataset.density = preferences.density
    const applyTheme = () => {
      const theme = resolveTheme(preferences.theme)
      root.dataset.theme = theme
      document
        .querySelector('meta[name="theme-color"]')
        ?.setAttribute('content', theme === 'light' ? '#e6e6e9' : '#101010')
      window.beddcodeDesktop?.setTheme?.(theme)
    }
    applyTheme()
    const media = window.matchMedia?.('(prefers-color-scheme: light)')
    media?.addEventListener('change', applyTheme)
    root.dataset.motion = preferences.reduceMotion ? 'reduced' : 'normal'
    root.style.setProperty(
      '--font-ui',
      preferences.uiFont === 'system'
        ? "system-ui, 'Segoe UI', sans-serif"
        : "'Inter', system-ui, 'Segoe UI', sans-serif",
    )
    return () => media?.removeEventListener('change', applyTheme)
  }, [preferences.theme, preferences.density, preferences.uiFont, preferences.reduceMotion])
  const settings = useLocation({ select: (location) => location.pathname === '/settings' })
  // Design is a screen of its own: the whole window, no sessions list or side panes.
  const design = useLocation({ select: (location) => location.pathname === '/design' })
  const navigate = useNavigate()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        useUiStore.getState().setSearchOpen(true)
        if (settings) void navigate({ to: '/' })
      }
      // Ctrl/Cmd+Alt+B: collapse or expand the right pane (by key position, so macOS's ∫ works).
      if ((event.ctrlKey || event.metaKey) && event.altKey && event.code === 'KeyB') {
        event.preventDefault()
        useUiStore.getState().togglePaneCollapsed()
      }
      // Ctrl+Tab / Ctrl+Shift+Tab, or Ctrl/Cmd+Alt+Down / Up: the next or previous session in the sidebar.
      const cycleKeys =
        (event.ctrlKey && event.key === 'Tab') ||
        ((event.ctrlKey || event.metaKey) &&
          event.altKey &&
          (event.key === 'ArrowDown' || event.key === 'ArrowUp'))
      if (cycleKeys) {
        const rows = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('.session-list .session-row'),
        )
        if (rows.length) {
          event.preventDefault()
          const back = event.key === 'ArrowUp' || (event.key === 'Tab' && event.shiftKey)
          const at = rows.findIndex((row) => row.classList.contains('active'))
          const next =
            at < 0
              ? back
                ? rows.length - 1
                : 0
              : (at + (back ? -1 : 1) + rows.length) % rows.length
          rows[next]!.click()
          rows[next]!.scrollIntoView({ block: 'nearest' })
        }
      }
      // Ctrl/Cmd+O: Browse… for a folder on the host the Add folder menu points at.
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.shiftKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'o'
      ) {
        event.preventDefault()
        void chooseFolder(useFolderFlow.getState().menuHostKey)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, settings])
  const layers = (
    <>
      <FolderBrowserLayer />
      <FolderPickerHint />
      <WindowBar />
      <HostStatusBanner />
    </>
  )
  if (settings)
    return (
      <>
        <Outlet />
        {layers}
      </>
    )
  if (design)
    return (
      <>
        <div className="shell-frame">
          <LeftRail />
          <div className="shell shell-solo">
            <div className="main-stack">
              <Outlet />
            </div>
          </div>
        </div>
        {layers}
      </>
    )
  return (
    <>
      <div className="shell-frame">
        <LeftRail />
        <Group
          orientation="horizontal"
          className={`shell ${sliding ? 'pane-sliding' : ''}`}
          defaultLayout={layout.defaultLayout}
          onLayoutChanged={layout.onLayoutChanged}
        >
          <Panel
            id="sidebar"
            className="shell-panel"
            defaultSize="24%"
            minSize="220px"
            maxSize="520px"
            groupResizeBehavior="preserve-pixel-size"
          >
            <Sidebar />
          </Panel>
          <Separator className="shell-sep" />
          <Panel id="main" className="shell-panel" minSize="320px">
            <div className="main-stack">
              <Outlet />
              <FolderToast />
            </div>
          </Panel>
          <Separator className="shell-sep" disabled={!activePane} />
          <Panel
            id="right"
            className="shell-panel"
            panelRef={rightPanel}
            collapsible
            collapsedSize={RAIL_WIDTH}
            onResize={onRightResize}
            defaultSize="30%"
            // The window buttons' card takes the end of an open pane's header row; the tabs still fit.
            minSize={appWindowControls() ? '366px' : '280px'}
            maxSize="75%"
            groupResizeBehavior="preserve-pixel-size"
          >
            <RightRail wantWidth={wantWidth} />
          </Panel>
        </Group>
      </div>
      {layers}
    </>
  )
}

/** Remembers panel sizes between launches; nothing is saved when storage is unavailable. */
function layoutStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}
