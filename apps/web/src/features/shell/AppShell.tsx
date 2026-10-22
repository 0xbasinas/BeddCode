import { useCallback, useEffect, useRef, useState } from 'react'
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { startHosts } from '../../stores/host.ts'
import { RightRail } from './RightRail.tsx'
import { WindowBar } from './WindowBar.tsx'
import { RAIL_WIDTH, openPaneWidth, rememberPaneWidth } from './paneWidth.ts'
import { Sidebar } from './Sidebar.tsx'
import { useAppPreferences } from '../../stores/appPreferences.ts'
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
    root.dataset.motion = preferences.reduceMotion ? 'reduced' : 'normal'
    root.style.setProperty(
      '--font-ui',
      preferences.uiFont === 'system'
        ? "system-ui, 'Segoe UI', sans-serif"
        : "'Inter', system-ui, 'Segoe UI', sans-serif",
    )
  }, [preferences.density, preferences.uiFont, preferences.reduceMotion])
  const settings = useLocation({ select: (location) => location.pathname === '/settings' })
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
    </>
  )
  if (settings)
    return (
      <>
        <Outlet />
        {layers}
      </>
    )
  return (
    <>
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
          // The app's own window buttons take part of the header row; the tabs still need to fit.
          minSize={appWindowControls() ? '320px' : '280px'}
          maxSize="75%"
          groupResizeBehavior="preserve-pixel-size"
        >
          <RightRail wantWidth={wantWidth} />
        </Panel>
      </Group>
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
