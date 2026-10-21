import { useEffect, useRef, type RefObject } from 'react'

const NEAR_END_PX = 80

/**
 * Keeps a scroller pinned to its end while content grows, but only while the reader is at the
 * end. Scrolling up releases the pin; returning to the bottom (or the user sending a message,
 * which adds a user item) re-arms it.
 */
export function useFollowEnd(ref: RefObject<HTMLElement | null>, dependency: unknown) {
  const pinned = useRef(true)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [ref])

  useEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [ref, dependency])
}
