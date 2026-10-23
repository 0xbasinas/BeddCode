/**
 * The session a tapped alert is about: its `sessionId`, or the `beddcode://session/<id>` link it
 * carries. Anything else (a test alert, a malformed payload) opens nothing.
 */
export function sessionOfAlert(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined
  const d = data as Record<string, unknown>
  const valid = (id: unknown) =>
    typeof id === 'string' && /^[\w-]{1,128}$/.test(id) ? id : undefined
  return (
    valid(d.sessionId) ??
    (typeof d.url === 'string'
      ? valid(/^beddcode:\/\/session\/([^/?#]+)/.exec(d.url)?.[1])
      : undefined)
  )
}
