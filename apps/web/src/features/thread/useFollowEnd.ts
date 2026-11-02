import { useCallback, useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { readingPosition, rememberReadingPosition } from './threadState.ts'
import { captureReadingAnchor } from './scrollAnchor.ts'

const NEAR_END_PX = 80
const noop = () => {}

/**
 * Keeps a scroller pinned to its end while content grows, but only while the reader is at the
 * end. Scrolling up releases the pin; returning to the bottom (or the user sending a message,
 * which adds a user item) re-arms it.
 */
export function useFollowEnd(
  ref: RefObject<HTMLElement | null>,
  dependency: unknown,
  memoryKey: string,
) {
  const pinned = useRef(true)
  const observing = useRef(false)
  const ready = dependency !== undefined

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const saved = readingPosition(memoryKey)
    pinned.current = saved?.following ?? true
    el.scrollTop = pinned.current ? el.scrollHeight : (saved?.top ?? 0)
    // The anchor only matters while the reader is off the end; at the end the observer pins instead.
    let restore = pinned.current ? noop : captureReadingAnchor(el)
    let lastTop = el.scrollTop
    const onScroll = () => {
      const fromEnd = el.scrollHeight - el.scrollTop - el.clientHeight
      // Moving up lets go at once. Waiting until the reader is far from the end meant the first
      // wheel ticks were undone by the next growth of a running tool call, which looked like jitter.
      // (Content shrinking clamps the position down to the end; that is not the reader.) Moving down (or the pin's own jump to the end) re-arms near the end.
      pinned.current = el.scrollTop < lastTop - 1 && fromEnd > 2 ? false : fromEnd < NEAR_END_PX
      lastTop = el.scrollTop
      rememberReadingPosition(memoryKey, { top: el.scrollTop, following: pinned.current })
      // Measuring the anchor costs several layout reads per scroll event, so skip it when pinned.
      restore = pinned.current ? noop : captureReadingAnchor(el)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    // Content keeps growing after first paint (markdown, images, highlighted code); stay at the end
    // while pinned so a session opens at its latest message without a visible jump. The observer
    // reports after layout, so reading scrollHeight here does not force an extra layout.
    const content = el.firstElementChild
    const observer = content
      ? new ResizeObserver(() => {
          if (pinned.current) el.scrollTop = el.scrollHeight
          else restore()
        })
      : undefined
    if (content) observer?.observe(content)
    observing.current = observer !== undefined
    return () => {
      observing.current = false
      rememberReadingPosition(memoryKey, { top: el.scrollTop, following: pinned.current })
      el.removeEventListener('scroll', onScroll)
      observer?.disconnect()
    }
  }, [ref, memoryKey, ready])

  useLayoutEffect(() => {
    // New items change the content's size, and the observer above pins to the end after layout.
    // Reading scrollHeight here, right after React wrote the DOM, would force a layout on every
    // streamed update; only do it when there is no observer to rely on.
    if (observing.current) return
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [ref, dependency])

  const follow = useCallback(() => {
    pinned.current = true
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    rememberReadingPosition(memoryKey, { top: el?.scrollTop ?? 0, following: true })
  }, [ref, memoryKey])
  /** Stops following the end. Call before scrolling somewhere on purpose, or growth snaps back. */
  const release = useCallback(() => {
    pinned.current = false
    rememberReadingPosition(memoryKey, { following: false })
  }, [memoryKey])
  return useMemo(() => ({ follow, release }), [follow, release])
}
