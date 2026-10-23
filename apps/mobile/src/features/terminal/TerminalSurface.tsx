import { forwardRef, useImperativeHandle, useRef } from 'react'

import { colors } from '@/theme/tokens'
import { Web, type WebHandle } from '@/ui/WebViewCompat'
import { TERMINAL_HTML } from './terminalHtml'
import { useTerminalBridge } from './useTerminalBridge'

export interface TerminalHandle {
  focus(): void
  clearSelection(): void
}

interface Props {
  hostKey: string
  id: string
  onSelection?(text: string): void
  takeCtrl?(): boolean
}

/** One shell drawn by xterm.js inside a WebView that ships with the app. */
export const TerminalSurface = forwardRef<TerminalHandle, Props>(function TerminalSurface(
  { hostKey, id, onSelection, takeCtrl },
  ref,
) {
  const web = useRef<WebHandle>(null)
  const post = (message: object) => web.current?.postMessage(JSON.stringify(message))
  const handle = useTerminalBridge({ hostKey, id, post, onSelection, takeCtrl })

  useImperativeHandle(ref, () => ({
    focus: () => post({ type: 'focus' }),
    clearSelection: () => post({ type: 'clearSelection' }),
  }))

  return (
    <Web
      ref={web}
      originWhitelist={['*']}
      source={{ html: TERMINAL_HTML }}
      onMessage={(event: { nativeEvent: { data: string } }) => handle(event.nativeEvent.data)}
      style={{ flex: 1, backgroundColor: colors.terminal }}
      containerStyle={{ backgroundColor: colors.terminal }}
      keyboardDisplayRequiresUserAction={false}
      hideKeyboardAccessoryView
      scrollEnabled={false}
      overScrollMode="never"
      bounces={false}
      automaticallyAdjustContentInsets={false}
      setSupportMultipleWindows={false}
    />
  )
})
