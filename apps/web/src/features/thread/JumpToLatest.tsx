import { ArrowDown } from 'lucide-react'
import { useEffect, useRef, useState, type RefObject } from 'react'

const AWAY_PX = 240

/**
 * A floating button shown while the reader has scrolled away from the end of the thread. It counts
 * the items that arrived since they left the end, and jumps back to the latest on click.
 */
export function JumpToLatest({
  scroller,
  itemCount,
  onJump,
}: {
  scroller: RefObject<HTMLElement | null>
  itemCount: number
  onJump(): void
}) {
  const [away, setAway] = useState(false)
  const [seen, setSeen] = useState(itemCount)
  const awayRef = useRef(false)

  useEffect(() => {
    const el = scroller.current
    if (!el) return
    const measure = () => {
      const isAway = el.scrollHeight - el.scrollTop - el.clientHeight > AWAY_PX
      awayRef.current = isAway
      setAway(isAway)
    }
    measure()
    el.addEventListener('scroll', measure, { passive: true })
    return () => el.removeEventListener('scroll', measure)
  }, [scroller])

  // While at the end nothing is unread.
  useEffect(() => {
    if (!away) setSeen(itemCount)
  }, [away, itemCount])

  if (!away) return null
  const unread = Math.max(0, itemCount - seen)
  return (
    <button
      className="jump-latest"
      onClick={onJump}
      aria-label={unread ? `Jump to latest, ${unread} new` : 'Jump to latest'}
      title="Jump to latest"
    >
      <ArrowDown size={16} />
      {unread > 0 && <span className="jump-latest-count">{unread > 99 ? '99+' : unread}</span>}
    </button>
  )
}
