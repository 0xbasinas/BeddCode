import { useEffect } from 'react'
import { Outlet } from '@tanstack/react-router'
import { connectToLocalHost } from '../../stores/host.ts'
import { RightRail } from './RightRail.tsx'
import { Sidebar } from './Sidebar.tsx'

export function AppShell() {
  useEffect(() => connectToLocalHost(), [])
  return (
    <div className="shell">
      <Sidebar />
      <Outlet />
      <RightRail />
    </div>
  )
}
