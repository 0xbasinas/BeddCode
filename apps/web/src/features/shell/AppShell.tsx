import { useCallback, useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { Group, Panel, Separator, useDefaultLayout, usePanelRef } from 'react-resizable-panels'
import { startHosts } from '../../stores/host.ts'
import { RightRail } from './RightRail.tsx'
import { Sidebar } from './Sidebar.tsx'
import { useAppPreferences } from '../../stores/appPreferences.ts'
import { useUiStore } from '../../stores/ui.ts'
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
  const preferences = useAppPreferences((s) => s.values)
  useEffect(() => {
    const root = document.documentElement
    root.dataset.desktop = window.beddcodeDesktop ? 'true' : 'false'
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
        className="shell"
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
        <Separator className="shell-sep" />
        <Panel
          id="right"
          className="shell-panel"
          panelRef={rightPanel}
          defaultSize="30%"
          minSize="280px"
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
