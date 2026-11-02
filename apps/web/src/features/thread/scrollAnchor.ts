/** Remember the first visible message by identity, not the height of everything above it. */
export function captureReadingAnchor(scroller: HTMLElement): () => void {
  const top = scroller.getBoundingClientRect().top
  // Messages sit in document order, so their bottoms only grow: binary-search the first one that
  // ends below the top edge instead of measuring every message (this runs on each scroll event).
  const nodes = scroller.querySelectorAll<HTMLElement>('[data-msg-id]')
  let low = 0
  let high = nodes.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (nodes[mid]!.getBoundingClientRect().bottom > top) high = mid
    else low = mid + 1
  }
  const message = nodes[low]
  if (!message) return () => {}
  const id = message.dataset.msgId!
  const offset = message.getBoundingClientRect().top - top
  return () => {
    const current = scroller.querySelector<HTMLElement>(`[data-msg-id="${CSS.escape(id)}"]`)
    if (current)
      scroller.scrollTop +=
        current.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset
  }
}
