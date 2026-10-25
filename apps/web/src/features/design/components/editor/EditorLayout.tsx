// @ts-nocheck
import { useEditorStore } from '../../store/editor-store'
import { TopBar } from './TopBar'
import { LeftSidebar } from './LeftSidebar'
import { Canvas } from './Canvas'
import { RightSidebar } from './RightSidebar'
import { Toolbar } from './Toolbar'
import { PrototypePlayer } from './prototype/PrototypePlayer'
import { FindReplaceModal } from './FindReplaceModal'
import { ShortcutsModal } from './ShortcutsModal'
import { VersionHistoryPanel } from './VersionHistoryPanel'

/** Left sidebar 241px, right sidebar 320px (the Figma UI3 measurements OpenFigma uses). */
export function EditorLayout() {
  const { leftSidebarVisible, rightSidebarVisible } = useEditorStore()
  return (
    <div className="design-root h-full w-full flex flex-col overflow-hidden bg-[#1E1E1E]">
      <TopBar />
      <div className="flex-1 flex overflow-hidden relative min-h-0">
        {leftSidebarVisible && (
          <div className="w-[241px] shrink-0 overflow-hidden border-r border-[#383838]">
            <LeftSidebar />
          </div>
        )}
        <div className="relative flex-1 min-w-0 h-full">
          <Canvas />
          <Toolbar />
          <FindReplaceModal />
          <ShortcutsModal />
          <VersionHistoryPanel />
        </div>
        {rightSidebarVisible && (
          <div className="w-[320px] shrink-0 overflow-hidden border-l border-[#383838]">
            <RightSidebar />
          </div>
        )}
      </div>
      <PrototypePlayer />
    </div>
  )
}
