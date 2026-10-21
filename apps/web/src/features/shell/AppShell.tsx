import { useEffect } from 'react'
import { Outlet, useLocation, useNavigate } from '@tanstack/react-router'
import { startHosts } from '../../stores/host.ts'
import { RightRail } from './RightRail.tsx'
import { Sidebar } from './Sidebar.tsx'
import { useAppPreferences } from '../../stores/appPreferences.ts'
import { useUiStore } from '../../stores/ui.ts'

export function AppShell() {
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
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [navigate, settings])
  if (settings) return <Outlet />
  return (
    <div className="shell">
      <Sidebar />
      <Outlet />
      <RightRail />
    </div>
  )
}
