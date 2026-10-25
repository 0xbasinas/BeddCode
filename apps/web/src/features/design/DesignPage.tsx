import { EditorLayout } from './components/editor/EditorLayout.tsx'
import { Toaster } from './components/ui/toaster.tsx'
import './design.css'

/** The design canvas: its own screen, in the main area beside the sidebar. */
export function DesignPage() {
  return (
    <main className="panel design-main">
      <EditorLayout />
      <Toaster />
    </main>
  )
}
