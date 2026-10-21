import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { onHostFrame, sendHostFrame, useRuntime } from '../../stores/host.ts'
import { useHostKey } from '../../stores/HostScope.tsx'

const THEME = {
  background: '#0e0e0e',
  foreground: '#ececec',
  cursor: '#d4d4d4',
  cursorAccent: '#0e0e0e',
  selectionBackground: 'rgba(255, 255, 255, 0.15)',
}

/**
 * One shell, drawn with xterm.js. The shell lives on the host; this view attaches to it, gets
 * the buffered history first, and sends keystrokes and size changes back. Closing the view (or
 * losing the connection) never ends the shell.
 */
export function TerminalView({
  id,
  onSize,
}: {
  id: string
  onSize?(size: { cols: number; rows: number }): void
}) {
  const container = useRef<HTMLDivElement>(null)
  // A new connection means the server forgot our subscription: attach again.
  const hostKey = useHostKey()
  const { epoch } = useRuntime(hostKey)
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize

  useEffect(() => {
    const el = container.current
    if (!el) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.6,
      cursorBlink: true,
      scrollback: 5000,
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)

    const reportSize = () => {
      try {
        fit.fit()
      } catch {
        return // hidden or zero-sized: try again on the next resize
      }
      sendHostFrame(hostKey, { t: 'term.resize', id, cols: term.cols, rows: term.rows })
      onSizeRef.current?.({ cols: term.cols, rows: term.rows })
    }

    const stopFrames = onHostFrame(hostKey, (frame) => {
      if (frame.t === 'term.out' && frame.id === id) {
        // History replaces whatever is on screen so a re-attach never shows things twice.
        if (frame.replay) term.reset()
        term.write(frame.data)
      } else if (frame.t === 'term.exit' && frame.id === id) {
        const how = frame.code === null ? '' : ` with code ${frame.code}`
        term.write(`\r\n\x1b[90m[process exited${how}]\x1b[0m\r\n`)
      }
    })
    const stopInput = term.onData((data) => sendHostFrame(hostKey, { t: 'term.input', id, data }))

    sendHostFrame(hostKey, { t: 'term.attach', id })
    reportSize()
    term.focus()

    let timer: ReturnType<typeof setTimeout> | undefined
    const observer = new ResizeObserver(() => {
      clearTimeout(timer)
      timer = setTimeout(reportSize, 60)
    })
    observer.observe(el)

    return () => {
      clearTimeout(timer)
      observer.disconnect()
      sendHostFrame(hostKey, { t: 'term.detach', id })
      stopFrames()
      stopInput.dispose()
      term.dispose()
    }
  }, [hostKey, id, epoch])

  return <div className="terminal-host" ref={container} />
}
