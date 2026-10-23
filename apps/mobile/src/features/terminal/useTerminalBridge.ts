import { useCallback, useEffect, useRef } from 'react'

import { onHostFrame, sendHostFrame, useRuntime } from '@/host/store'

/** A message from the xterm page. */
type PageMessage =
  | { type: 'ready' }
  | { type: 'data'; data: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'selection'; text: string }

/** A message to the xterm page. */
export type ToPage =
  | { type: 'write'; data: string; reset?: boolean }
  | { type: 'exit'; code: number | null }
  | { type: 'focus' }
  | { type: 'clearSelection' }

/**
 * Connects one shell on a host to the xterm page that draws it. The shell lives on the host: this
 * attaches to it, hands the page its history first, and sends keystrokes and size changes back.
 * Leaving (or losing the connection) never ends the shell.
 *
 * `post` sends a message into the page; the returned function takes what the page says back.
 */
export function useTerminalBridge({
  hostKey,
  id,
  post,
  onSelection,
  takeCtrl,
}: {
  hostKey: string
  id: string
  post(message: ToPage): void
  onSelection?(text: string): void
  /** Whether Ctrl is armed; reading it also disarms it (it applies to the next key only). */
  takeCtrl?(): boolean
}): (raw: string) => void {
  // A new connection means the host forgot our subscription: attach again.
  const { epoch } = useRuntime(hostKey)
  const ready = useRef(false)
  const size = useRef<{ cols: number; rows: number } | undefined>(undefined)
  const postRef = useRef(post)
  postRef.current = post

  const attach = useCallback(() => {
    sendHostFrame(hostKey, { t: 'term.attach', id })
    if (size.current) sendHostFrame(hostKey, { t: 'term.resize', id, ...size.current })
  }, [hostKey, id])

  useEffect(() => {
    const stop = onHostFrame(hostKey, (frame) => {
      if (frame.t === 'term.out' && frame.id === id) {
        postRef.current({ type: 'write', data: frame.data, reset: frame.replay })
      } else if (frame.t === 'term.exit' && frame.id === id) {
        postRef.current({ type: 'exit', code: frame.code })
      }
    })
    if (ready.current) attach()
    return () => {
      stop()
      sendHostFrame(hostKey, { t: 'term.detach', id })
    }
  }, [hostKey, id, epoch, attach])

  return useCallback(
    (raw: string) => {
      let message: PageMessage
      try {
        message = JSON.parse(raw) as PageMessage
      } catch {
        return
      }
      switch (message.type) {
        case 'ready':
          ready.current = true
          attach()
          break
        case 'resize':
          size.current = { cols: message.cols, rows: message.rows }
          sendHostFrame(hostKey, { t: 'term.resize', id, ...size.current })
          break
        case 'data': {
          let data = message.data
          if (takeCtrl?.() && data.length === 1) {
            const code = data.toUpperCase().charCodeAt(0)
            // Ctrl+A..Z and a few punctuation keys map to control characters.
            if (code >= 64 && code <= 95) data = String.fromCharCode(code - 64)
          }
          sendHostFrame(hostKey, { t: 'term.input', id, data })
          break
        }
        case 'selection':
          onSelection?.(message.text)
          break
      }
    },
    [attach, hostKey, id, onSelection, takeCtrl],
  )
}

/** Sends keystrokes that did not come from the page (the key bar above the keyboard). */
export function sendKeys(hostKey: string, id: string, data: string) {
  return sendHostFrame(hostKey, { t: 'term.input', id, data })
}
