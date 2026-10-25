// @ts-nocheck
import { useEditorStore } from '../../store/editor-store'
import { TopBar } from './TopBar'
import { LeftSidebar } from './LeftSidebar'
import { Canvas } from './Canvas'
import { RightSidebar } from './RightSidebar'
import { Toolbar } from './Toolbar'
import { FindReplaceModal } from './FindReplaceModal'
import { ShortcutsModal } from './ShortcutsModal'

/** Left sidebar 241px, right sidebar 320px (the Figma UI3 measurements OpenFigma uses). */
export function EditorLayout() {
  const { leftSidebarVisible, rightSidebarVisible } = useEditorStore()
  return (
    <div className="design-root @container h-full w-full flex flex-col overflow-hidden bg-[color:var(--dc-app)]">
      <TopBar />
      <div className="flex-1 flex overflow-hidden relative min-h-0">
        {leftSidebarVisible && (
          <div className="design-chrome w-[clamp(170px,20cqw,220px)] @max-[640px]:hidden shrink-0 overflow-hidden border-r border-[color:var(--dc-border)]">
            <LeftSidebar />
          </div>
        )}
        <div className="relative flex-1 min-w-0 h-full">
          <Canvas />
          <Toolbar />
          <FindReplaceModal />
          <ShortcutsModal />
        </div>
        {rightSidebarVisible && (
          <div className="design-chrome w-[clamp(200px,24cqw,272px)] @max-[900px]:hidden shrink-0 overflow-hidden border-l border-[color:var(--dc-border)]">
            <RightSidebar />
          </div>
        )}
      </div>
    </div>
  )
}
