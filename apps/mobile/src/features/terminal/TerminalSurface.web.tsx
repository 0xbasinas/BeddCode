import { createElement, forwardRef, useEffect, useImperativeHandle, useRef } from 'react'

import { colors } from '@/theme/tokens'
import { TERMINAL_HTML } from './terminalHtml'
import type { TerminalHandle } from './TerminalSurface'
import { useTerminalBridge } from './useTerminalBridge'

interface Props {
  hostKey: string
  id: string
  onSelection?(text: string): void
  takeCtrl?(): boolean
}

/** The same page in an iframe, for the browser build (and for testing the app in a browser). */
export const TerminalSurface = forwardRef<TerminalHandle, Props>(function TerminalSurface(
  { hostKey, id, onSelection, takeCtrl },
  ref,
) {
  const frame = useRef<HTMLIFrameElement | null>(null)
  const post = (message: object) =>
    frame.current?.contentWindow?.postMessage(JSON.stringify(message), '*')
  const handle = useTerminalBridge({ hostKey, id, post, onSelection, takeCtrl })
  const handleRef = useRef(handle)
  handleRef.current = handle

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source === frame.current?.contentWindow && typeof event.data === 'string') {
        handleRef.current(event.data)
      }
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [])

  useImperativeHandle(ref, () => ({
    focus: () => post({ type: 'focus' }),
    clearSelection: () => post({ type: 'clearSelection' }),
  }))

  return createElement('iframe', {
    ref: frame,
    srcDoc: TERMINAL_HTML,
    style: {
      flex: 1,
      border: 'none',
      width: '100%',
      height: '100%',
      backgroundColor: colors.terminal,
    },
  })
})
