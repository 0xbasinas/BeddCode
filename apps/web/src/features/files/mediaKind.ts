import type { MediaKind } from '@beddcode/contracts'

/**
 * Files shown as an image, video or audio instead of in the editor, from their extension. The host
 * has the same list (and decides what it will serve); this only picks the viewer without reading
 * the file first.
 */
const KINDS: Record<string, MediaKind> = {
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  mp4: 'video',
  m4v: 'video',
  webm: 'video',
  ogv: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  oga: 'audio',
  m4a: 'audio',
  flac: 'audio',
}

export function mediaKindOf(path: string): MediaKind | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? KINDS[name.slice(dot + 1).toLowerCase()] : undefined
}

/** The host's HTTP address, from the address its WebSocket is connected to. */
export function httpBase(wsRoute: string): string | undefined {
  try {
    const url = new URL(wsRoute)
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return undefined
    return `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`
  } catch {
    return undefined
  }
}
