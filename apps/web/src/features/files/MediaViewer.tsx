import { useEffect, useState } from 'react'
import { FileVideo } from 'lucide-react'
import type { FileMedia, MediaKind } from '@beddcode/contracts'
import { activeRoute, hostRequest } from '../../stores/host.ts'
import { formatBytes } from '../../ui/format.ts'
import { httpBase } from './mediaKind.ts'
import { splitFolderId } from './filesStore.ts'

/** Shows an image, plays a video or audio file. The bytes come over HTTP from the host. */
export function MediaViewer({
  cwd,
  path,
  kind,
  version,
  onInfo,
}: {
  /** Folder id (host and folder), as the files store names it. */
  cwd: string
  path: string
  kind: MediaKind
  /** Bumped when the file changed on disk, so it is fetched again. */
  version: number
  onInfo(info: string): void
}) {
  const [media, setMedia] = useState<FileMedia | null>(null)
  const [src, setSrc] = useState<string>()
  const [error, setError] = useState<string>()
  // The ticket lapses after an hour (or a host restart); one fresh one is tried per failure.
  const [attempt, setAttempt] = useState(0)
  const [actual, setActual] = useState(false)

  useEffect(() => {
    let live = true
    const { hostKey, cwd: folder } = splitFolderId(cwd)
    setError(undefined)
    hostRequest(hostKey, 'files.media', { cwd: folder, path }).then(
      (m) => {
        if (!live) return
        const route = activeRoute(hostKey)
        const base = route ? httpBase(route) : undefined
        if (!m) setError('This file cannot be previewed.')
        else if (!base) setError('The host is not reachable right now.')
        else {
          setMedia(m)
          setSrc(`${base}${m.url}`)
        }
      },
      (err: unknown) => live && setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      live = false
    }
  }, [cwd, path, version, attempt])

  useEffect(() => {
    if (media) onInfo(`${media.mime} · ${formatBytes(media.size)}`)
  }, [media, onInfo])

  const failed = (unsupported: boolean) => {
    if (!unsupported && attempt < 1) setAttempt(attempt + 1)
    else
      setError(
        unsupported
          ? "This browser can't play this file's format."
          : 'The file could not be loaded.',
      )
  }

  if (error) {
    return (
      <div className="pane-empty">
        <span className="empty-icon">
          <FileVideo size={26} />
        </span>
        <h3>Can&apos;t show this file</h3>
        <p>{error}</p>
      </div>
    )
  }
  if (!src) return <div className="media-view" aria-busy />

  return (
    <div className={`media-view ${kind}`}>
      {kind === 'image' ? (
        <div className={`media-scroll ${actual ? 'actual' : ''}`}>
          <img
            src={src}
            alt={path}
            draggable={false}
            title={actual ? 'Click to fit' : 'Click for actual size'}
            onClick={() => setActual(!actual)}
            onLoad={(e) =>
              onInfo(
                `${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight} · ${media?.mime ?? ''} · ${formatBytes(media?.size ?? 0)}`,
              )
            }
            onError={() => failed(false)}
          />
        </div>
      ) : kind === 'video' ? (
        <video
          src={src}
          controls
          preload="metadata"
          onError={(e) => failed(e.currentTarget.error?.code === 4)}
        />
      ) : (
        <audio
          src={src}
          controls
          preload="metadata"
          onError={(e) => failed(e.currentTarget.error?.code === 4)}
        />
      )}
    </div>
  )
}
