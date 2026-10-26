import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react'
import { readingPosition, rememberReadingPosition } from './threadState.ts'

const NEAR_END_PX = 80

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
  const ready = dependency !== undefined

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const saved = readingPosition(memoryKey)
    pinned.current = saved?.following ?? true
    el.scrollTop = pinned.current ? el.scrollHeight : (saved?.top ?? 0)
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_END_PX
      rememberReadingPosition(memoryKey, { top: el.scrollTop, following: pinned.current })
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      rememberReadingPosition(memoryKey, { top: el.scrollTop, following: pinned.current })
      el.removeEventListener('scroll', onScroll)
    }
  }, [ref, memoryKey, ready])

  useLayoutEffect(() => {
    const el = ref.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [ref, dependency])

  return useCallback(() => {
    pinned.current = true
    const el = ref.current
    if (el) el.scrollTop = el.scrollHeight
    rememberReadingPosition(memoryKey, { top: el?.scrollTop ?? 0, following: true })
  }, [ref, memoryKey])
}
