type Listenable = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>

/**
 * Calls `onWake` when the page is likely to have just come back: the network returned, the tab or
 * window became visible again, or the desktop app reports the machine woke. Returns the function
 * that stops listening.
 */
export function onDeviceWake(
  onWake: () => void,
  win: Listenable & { navigator?: { onLine?: boolean } } = window,
  doc: Listenable & { visibilityState?: string } = document,
): () => void {
  const online = () => onWake()
  const visible = () => {
    if (doc.visibilityState === 'visible') onWake()
  }
  win.addEventListener('online', online)
  win.addEventListener('focus', visible)
  doc.addEventListener('visibilitychange', visible)
  return () => {
    win.removeEventListener('online', online)
    win.removeEventListener('focus', visible)
    doc.removeEventListener('visibilitychange', visible)
  }
}
