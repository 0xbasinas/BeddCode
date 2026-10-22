/**
 * The desktop app draws its own title bar; the system's window controls (minimise, maximise,
 * close) are painted over the top of the page. These helpers tell the CSS where they are, so
 * headers centre on the same line and nothing interactive sits underneath them.
 */
export interface ControlsInsets {
  /** Width the controls cover at the left edge (macOS) and at the right edge (Windows, Linux). */
  left: number
  right: number
  /** Height of the title-bar band. */
  height: number
}

/** Where the controls are, from the free title-bar area the browser reports. */
export function controlsInsets(
  area: { x: number; width: number; height: number },
  viewportWidth: number,
): ControlsInsets {
  return {
    left: Math.max(0, Math.round(area.x)),
    right: Math.max(0, Math.round(viewportWidth - area.x - area.width)),
    height: Math.max(0, Math.round(area.height)),
  }
}

interface Overlay extends EventTarget {
  visible: boolean
  getTitlebarAreaRect(): DOMRect
}

/** Keeps `data-wco` and `--wco-left/right/height` on the root in step with the controls. */
export function trackWindowControls(root = document.documentElement): () => void {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: Overlay })
    .windowControlsOverlay
  if (!overlay) return () => {}
  const apply = () => {
    if (!overlay.visible) {
      delete root.dataset.wco
      return
    }
    const insets = controlsInsets(overlay.getTitlebarAreaRect(), window.innerWidth)
    root.dataset.wco = 'true'
    root.style.setProperty('--wco-left', `${insets.left}px`)
    root.style.setProperty('--wco-right', `${insets.right}px`)
    root.style.setProperty('--wco-height', `${insets.height}px`)
  }
  apply()
  overlay.addEventListener('geometrychange', apply)
  window.addEventListener('resize', apply)
  return () => {
    overlay.removeEventListener('geometrychange', apply)
    window.removeEventListener('resize', apply)
  }
}
