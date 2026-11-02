import { memo, useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import type { TranscriptItem } from '@beddcode/client-runtime'

/** The collapsed rail shows this many ticks around the message being read. */
const RAIL_TICKS = 11

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

/**
 * A rail of ticks at the thread's edge, one per message you sent. Hover it for the list; picking
 * one scrolls there. The tick of the message being read is highlighted.
 */
export const MessageNav = memo(function MessageNav({
  items,
  scroller,
  onJump,
}: {
  items: TranscriptItem[]
  scroller: RefObject<HTMLElement | null>
  /** Draws the message if it is not yet (long threads draw only their latest part) and scrolls to it. */
  onJump(id: string): void
}) {
  const messages = useMemo(
    () =>
      items.flatMap((i) =>
        i.kind === 'message' && i.role === 'user' && i.text.trim()
          ? [{ id: i.id, label: oneLine(i.text) }]
          : [],
      ),
    [items],
  )
  const [active, setActive] = useState(0)
  const ids = useRef<string[]>([])
  ids.current = messages.map((m) => m.id)

  // The message being read is the last one that has reached the upper part of the view.
  useEffect(() => {
    const el = scroller.current
    if (!el) return
    let frame = 0
    const measure = () => {
      frame = 0
      const line = el.getBoundingClientRect().top + el.clientHeight * 0.35
      // One pass over the drawn messages, not one subtree search per message of yours: that was
      // messages x DOM size on every streamed frame, which blocked typing in long threads.
      const drawn = new Map<string, Element>()
      el.querySelectorAll('[data-msg-id]').forEach((node) => {
        const id = node.getAttribute('data-msg-id')
        if (id) drawn.set(id, node)
      })
      let found = -1
      let firstDrawn = -1
      ids.current.forEach((id, index) => {
        const node = drawn.get(id)
        if (!node) return
        if (firstDrawn < 0) firstDrawn = index
        if (node.getBoundingClientRect().top <= line) found = index
      })
      setActive(found >= 0 ? found : Math.max(0, firstDrawn))
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    // Streaming changes the DOM constantly but rarely moves which message is being read, so DOM
    // changes are measured at most a few times a second. Scrolling stays immediate.
    let settle: ReturnType<typeof setTimeout> | undefined
    const queueSoon = () => {
      if (settle === undefined)
        settle = setTimeout(() => {
          settle = undefined
          queue()
        }, 250)
    }
    queue()
    el.addEventListener('scroll', queue, { passive: true })
    const observer = new MutationObserver(queueSoon)
    observer.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener('scroll', queue)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
      if (settle !== undefined) clearTimeout(settle)
    }
  }, [scroller, messages.length])

  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  // Centre the message being read when the list opens. Only the list scrolls: scrollIntoView would
  // also move the thread behind it. Not re-run while open, so clicking does not shift rows.
  useEffect(() => {
    if (!open) return
    const box = list.current
    const row = box?.querySelector<HTMLElement>('[data-active="true"]')
    if (!box || !row) return
    const offset = row.getBoundingClientRect().top - box.getBoundingClientRect().top
    box.scrollTop += offset - (box.clientHeight - row.clientHeight) / 2
  }, [open])

  if (messages.length < 2) return null
  const from = Math.max(
    0,
    Math.min(active - Math.floor(RAIL_TICKS / 2), messages.length - RAIL_TICKS),
  )
  return (
    <nav
      className={`message-nav${open ? ' open' : ''}`}
      aria-label="Your messages"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <div className="message-nav-list" ref={list}>
        {messages.map((m, index) => (
          <button
            key={m.id}
            className="message-nav-row"
            data-active={index === active}
            onClick={() => {
              setActive(index)
              setOpen(false)
              onJump(m.id)
            }}
            title={m.label}
          >
            <span className="message-nav-label">{m.label}</span>
            <span className="message-nav-tick" />
          </button>
        ))}
      </div>
      <div className="message-nav-rail" aria-hidden="true">
        {messages.slice(from, from + RAIL_TICKS).map((m, i) => (
          <span key={m.id} className="message-nav-tick" data-active={from + i === active} />
        ))}
      </div>
    </nav>
  )
})
