/** Remember the first visible message by identity, not the height of everything above it. */
export function captureReadingAnchor(scroller: HTMLElement): () => void {
  const top = scroller.getBoundingClientRect().top
  const message = Array.from(scroller.querySelectorAll<HTMLElement>('[data-msg-id]')).find(
    (node) => node.getBoundingClientRect().bottom > top,
  )
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
