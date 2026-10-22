import { Copy, Minus, Square, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { appWindowControls } from '../../ui/desktop.ts'

/**
 * The app's title bar: a slim strip across the top of the window, above the panes, with minimize,
 * maximize/restore and close at its right end, drawn in the app's style. Only inside the frameless desktop window on Linux and Windows; macOS keeps its traffic
 * lights and the browser build has no window to control. Double-clicking a drag region is left to
 * the system (Windows, macOS, and Chromium's own handling on Linux).
 */
export function WindowBar() {
  const controls = useMemo(appWindowControls, [])
  const [maximized, setMaximized] = useState(false)
  useEffect(() => {
    if (!controls) return
    let live = true
    void controls.isMaximized().then((value) => live && setMaximized(value))
    const off = controls.onMaximizedChange(setMaximized)
    return () => {
      live = false
      off()
    }
  }, [controls])
  if (!controls) return null
  return (
    <div className="titlebar">
      <div className="winbar" role="group" aria-label="Window">
        <button
          className="icon-btn"
          aria-label="Minimize"
          title="Minimize"
          onClick={() => void controls.minimize()}
        >
          <Minus size={16} />
        </button>
        <button
          className="icon-btn"
          aria-label={maximized ? 'Restore' : 'Maximize'}
          title={maximized ? 'Restore' : 'Maximize'}
          onClick={() => void controls.toggleMaximize().then(setMaximized)}
        >
          {maximized ? <Copy size={14} className="winbar-restore" /> : <Square size={14} />}
        </button>
        <button
          className="icon-btn winbar-close"
          aria-label="Close"
          title="Close"
          onClick={() => void controls.close()}
        >
          <X size={16} />
        </button>
      </div>
    </div>
  )
}
