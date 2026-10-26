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
      let found = -1
      let firstDrawn = -1
      ids.current.forEach((id, index) => {
        const node = el.querySelector(`[data-msg-id="${CSS.escape(id)}"]`)
        if (!node) return
        if (firstDrawn < 0) firstDrawn = index
        if (node.getBoundingClientRect().top <= line) found = index
      })
      setActive(found >= 0 ? found : Math.max(0, firstDrawn))
    }
    const queue = () => {
      if (!frame) frame = requestAnimationFrame(measure)
    }
    queue()
    el.addEventListener('scroll', queue, { passive: true })
    const observer = new MutationObserver(queue)
    observer.observe(el, { childList: true, subtree: true })
    return () => {
      el.removeEventListener('scroll', queue)
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [scroller, messages.length])

  const list = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    list.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

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
            onClick={() => onJump(m.id)}
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
