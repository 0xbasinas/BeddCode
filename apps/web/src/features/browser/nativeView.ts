import { useEffect, useRef, useState, type RefObject } from 'react'
import type { BrowserRect } from '@beddcode/contracts'
import { browserCommand, nativeBrowser } from './browserStore.ts'

/**
 * App UI that floats above the pane. A native view is drawn above the whole page, so while one of
 * these covers it the view is swapped for a still picture of itself (see useNativeLayout).
 */
const OVERLAYS =
  '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[role=tooltip],dialog[open],.modal-backdrop,[data-covers-browser]'

const intersects = (a: DOMRect, b: BrowserRect) =>
  a.width > 0 &&
  a.height > 0 &&
  a.left < b.x + b.width &&
  a.right > b.x &&
  a.top < b.y + b.height &&
  a.bottom > b.y

/**
 * Does anything of the app's own lie over the frame? Floating menus and dialogs by role, plus a
 * sample of points across the frame for anything else (a toast, a popover without a role).
 */
export function isCovered(frame: Element, rect: BrowserRect, doc: Document = document): boolean {
  for (const el of doc.querySelectorAll(OVERLAYS)) {
    if (frame.contains(el) || el.contains(frame)) continue
    if (Number(getComputedStyle(el).opacity) === 0) continue
    if (intersects(el.getBoundingClientRect(), rect)) return true
  }
  const inset = 6
  const xs = [rect.x + inset, rect.x + rect.width / 2, rect.x + rect.width - inset]
  const ys = [rect.y + inset, rect.y + rect.height / 2, rect.y + rect.height - inset]
  for (const x of xs)
    for (const y of ys) {
      const hit = doc.elementFromPoint(x, y)
      if (hit && !frame.contains(hit)) return true
    }
  return false
}

/** The frame's inner box (inside its border) in CSS pixels, or null when it is not on screen. */
export function measure(el: HTMLElement): { rect: BrowserRect; radius: number } | null {
  if (!el.isConnected || (el.checkVisibility && !el.checkVisibility())) return null
  const box = el.getBoundingClientRect()
  const rect = {
    x: box.left + el.clientLeft,
    y: box.top + el.clientTop,
    width: el.clientWidth,
    height: el.clientHeight,
  }
  if (rect.width < 2 || rect.height < 2) return null
  const radius = Math.max(0, parseFloat(getComputedStyle(el).borderTopLeftRadius) - el.clientLeft)
  return { rect, radius: Number.isFinite(radius) ? radius : 0 }
}

/**
 * Keeps the desktop app's native page for `tabId` laid exactly over `frame`: follows resizes,
 * pane drags and window zoom every frame, hides it while `show` is false or the frame is off
 * screen, and swaps in a still picture while app UI covers it. Returns that picture, if any.
 */
export function useNativeLayout(
  frame: RefObject<HTMLElement | null>,
  tabId: number | null,
  show: boolean,
): string | null {
  const [snapshot, setSnapshot] = useState<string | null>(null)
  const frozen = useRef(false)

  useEffect(() => {
    if (!nativeBrowser()) return
    let raf = 0
    let tick = 0
    let sent = ''
    let covered = false
    let freezing = false
    let alive = true
    const send = (bounds: BrowserRect | null, radius = 0) => {
      const key = JSON.stringify([tabId, bounds, radius])
      if (key === sent) return
      sent = key
      void browserCommand({ op: 'layout', tabId, bounds, radius })
    }
    const step = () => {
      raf = requestAnimationFrame(step)
      const el = frame.current
      const measured = el && show && tabId !== null ? measure(el) : null
      if (!measured || !el) {
        covered = false
        if (frozen.current) {
          frozen.current = false
          setSnapshot(null)
        }
        return send(null)
      }
      // Sampling the page is cheap but not free; a few times a second is enough.
      if (tick++ % 6 === 0) covered = isCovered(el, measured.rect)
      if (covered) {
        if (frozen.current || freezing) return
        freezing = true
        void browserCommand<string | null>({ op: 'capture', tabId: tabId! }).then((src) => {
          freezing = false
          if (!alive || !covered) return
          frozen.current = true
          setSnapshot(src ?? null)
          send(null)
        })
        return
      }
      if (frozen.current) {
        frozen.current = false
        send(measured.rect, measured.radius)
        // The view is back on top; drop the picture under it a moment later (no flash).
        setTimeout(() => alive && !frozen.current && setSnapshot(null), 80)
        return
      }
      send(measured.rect, measured.radius)
    }
    step()
    return () => {
      alive = false
      cancelAnimationFrame(raf)
      frozen.current = false
      setSnapshot(null)
      void browserCommand({ op: 'layout', tabId: null, bounds: null })
    }
  }, [frame, tabId, show])

  return snapshot
}
