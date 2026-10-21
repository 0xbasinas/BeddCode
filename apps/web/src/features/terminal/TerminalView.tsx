import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { onHostFrame, sendHostFrame, useHostStore } from '../../stores/host.ts'

const THEME = {
  background: '#0d0d0d',
  foreground: '#ececec',
  cursor: '#f0a43c',
  cursorAccent: '#0d0d0d',
  selectionBackground: 'rgba(240, 164, 60, 0.3)',
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
  const epoch = useHostStore((s) => s.epoch)
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize

  useEffect(() => {
    const el = container.current
    if (!el) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
      fontSize: 13,
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
      sendHostFrame({ t: 'term.resize', id, cols: term.cols, rows: term.rows })
      onSizeRef.current?.({ cols: term.cols, rows: term.rows })
    }

    const stopFrames = onHostFrame((frame) => {
      if (frame.t === 'term.out' && frame.id === id) {
        // History replaces whatever is on screen so a re-attach never shows things twice.
        if (frame.replay) term.reset()
        term.write(frame.data)
      } else if (frame.t === 'term.exit' && frame.id === id) {
        const how = frame.code === null ? '' : ` with code ${frame.code}`
        term.write(`\r\n\x1b[90m[process exited${how}]\x1b[0m\r\n`)
      }
    })
    const stopInput = term.onData((data) => sendHostFrame({ t: 'term.input', id, data }))

    sendHostFrame({ t: 'term.attach', id })
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
      sendHostFrame({ t: 'term.detach', id })
      stopFrames()
      stopInput.dispose()
      term.dispose()
    }
  }, [id, epoch])

  return <div className="terminal-host" ref={container} />
}
