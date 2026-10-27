import { useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { View } from 'react-native'

import { PaneBar, type Pane } from '@/features/panes/PaneBar'
import { BrowserPane } from '@/features/browser/BrowserPane'
import { FilesPane } from '@/features/files/FilesPane'
import { GitPane } from '@/features/git/GitPane'
import { TerminalPane } from '@/features/terminal/TerminalPane'
import { ThreadPane } from '@/features/thread/ThreadPane'
import { Screen } from '@/ui/Screen'
import { useAfterTransition } from '@/ui/useAfterTransition'
import { useKeyboardVisible } from '@/ui/useKeyboardVisible'

/** One session, with the desktop's panes (thread, terminal, files, git, browser) along the bottom. */
export default function SessionScreen() {
  const { id } = useLocalSearchParams<{ id: string }>()
  const [pane, setPane] = useState<Pane>('thread')
  // Panes the user has opened stay mounted, so a terminal or an open file is still there on return.
  const [opened, setOpened] = useState<Set<Pane>>(new Set(['thread']))
  const keyboard = useKeyboardVisible()
  // The conversation is drawn once the screen has finished sliding in, so opening is not held up.
  const settled = useAfterTransition()
  const choose = (next: Pane) => {
    setPane(next)
    setOpened((s) => (s.has(next) ? s : new Set(s).add(next)))
  }

  return (
    <Screen bottom={false}>
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1, display: pane === 'thread' ? 'flex' : 'none' }}>
          {settled ? <ThreadPane sessionId={id} onOpenPane={choose} /> : null}
        </View>
        {(['terminal', 'files', 'git', 'browser'] as const).map((p) =>
          opened.has(p) ? (
            <View key={p} style={{ flex: 1, display: pane === p ? 'flex' : 'none' }}>
              {p === 'files' ? (
                <FilesPane sessionId={id} onAttached={() => choose('thread')} />
              ) : p === 'browser' ? (
                <BrowserPane sessionId={id} onSent={() => choose('thread')} />
              ) : p === 'terminal' ? (
                <TerminalPane
                  sessionId={id}
                  active={pane === 'terminal'}
                  onAttached={() => choose('thread')}
                />
              ) : p === 'git' ? (
                <GitPane sessionId={id} active={pane === 'git'} />
              ) : null}
            </View>
          ) : null,
        )}
      </View>
      {/* While typing, the keyboard is the bottom of the screen: the bar waits underneath it. */}
      {keyboard ? null : <PaneBar pane={pane} onChange={choose} />}
    </Screen>
  )
}
