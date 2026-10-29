import { useEffect, useRef } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal, type ILink } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { findTextLinks } from '@beddcode/client-runtime'
import { hostRequest, onHostFrame, sendHostFrame, useRuntime } from '../../stores/host.ts'
import { useHostKey } from '../../stores/HostScope.tsx'
import { openLocated, openUrl, wantsOutside } from '../links/links.tsx'

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
  cwd,
  readOnly = false,
  onSize,
  onSelection,
}: {
  id: string
  /** The terminal's folder: paths printed in it are read against this one. */
  cwd?: string
  /** Typing is not sent (an agent's terminal until the user takes it over). */
  readOnly?: boolean
  onSize?(size: { cols: number; rows: number }): void
  onSelection?(text: string): void
}) {
  const container = useRef<HTMLDivElement>(null)
  // A new connection means the server forgot our subscription: attach again.
  const hostKey = useHostKey()
  const { epoch } = useRuntime(hostKey)
  const onSizeRef = useRef(onSize)
  onSizeRef.current = onSize
  const onSelectionRef = useRef(onSelection)
  onSelectionRef.current = onSelection
  const readOnlyRef = useRef(readOnly)
  readOnlyRef.current = readOnly
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const termRef = useRef<Terminal | null>(null)

  useEffect(() => {
    const el = container.current
    if (!el) return

    const term = new Terminal({
      fontFamily: "'JetBrains Mono', ui-monospace, 'Cascadia Code', Consolas, monospace",
      fontSize: 12,
      lineHeight: 1.6,
      scrollback: 5000,
      theme: THEME,
      disableStdin: readOnlyRef.current,
      cursorBlink: !readOnlyRef.current,
    })
    termRef.current = term
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
    const stopInput = term.onData((data) => {
      if (!readOnlyRef.current) sendHostFrame(hostKey, { t: 'term.input', id, data })
    })
    const stopLinks = term.registerLinkProvider({
      provideLinks(y, callback) {
        void lineLinks(term, hostKey, cwdRef.current, y).then(callback, () => callback(undefined))
      },
    })
    const stopSelection = term.onSelectionChange(() =>
      onSelectionRef.current?.(term.getSelection()),
    )
    onSelectionRef.current?.('')

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
      stopLinks.dispose()
      termRef.current = null
      stopSelection.dispose()
      term.dispose()
    }
  }, [hostKey, id, epoch])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.disableStdin = readOnly
    term.options.cursorBlink = !readOnly
    if (!readOnly) term.focus()
  }, [readOnly])

  return <div className="terminal-host" ref={container} />
}

/**
 * The links on one row of the terminal: web addresses, and paths the host says are inside the
 * folder. Asked for when the pointer moves over the row, so only that row's paths are looked up.
 */
async function lineLinks(
  term: Terminal,
  hostKey: string,
  cwd: string | undefined,
  y: number,
): Promise<ILink[] | undefined> {
  const text = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
  const found = findTextLinks(text).slice(0, 20)
  if (!found.length) return undefined
  const paths = found.flatMap((l) => (l.kind === 'path' ? [l.path] : []))
  const located =
    cwd && paths.length
      ? await hostRequest(hostKey, 'files.locate', { cwd, paths })
          .then((r) => r.found)
          .catch(() => [])
      : []
  const where = new Map(paths.map((p, i) => [p, located[i] ?? null]))
  const links: ILink[] = []
  for (const link of found) {
    const range = { start: { x: link.start + 1, y }, end: { x: link.end, y } }
    if (link.kind === 'url') {
      links.push({
        range,
        text: link.text,
        decorations: { underline: true, pointerCursor: true },
        activate: (event) => openUrl(link.url, wantsOutside(event)),
      })
      continue
    }
    const spot = where.get(link.path)
    if (!spot || !cwd) continue
    links.push({
      range,
      text: link.text,
      decorations: { underline: true, pointerCursor: true },
      activate: (event) =>
        void openLocated(
          { hostKey, cwd },
          spot,
          { line: link.line, column: link.column },
          event.altKey,
        ),
    })
  }
  return links.length ? links : undefined
}
