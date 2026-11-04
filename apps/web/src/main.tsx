import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from '@tanstack/react-router'
import { AutoHandoff } from './features/shell/AutoHandoff.tsx'
import { router } from './router.tsx'
import './ui/shadcn.css'
import './ui/app.css'
import './ui/workspace.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AutoHandoff />
    <RouterProvider router={router} />
  </StrictMode>,
)
