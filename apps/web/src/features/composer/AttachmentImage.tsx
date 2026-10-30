import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { Paperclip, X } from 'lucide-react'
import { activeRoute, hostRequest } from '../../stores/host.ts'
import { httpBase, mediaKindOf } from '../files/mediaKind.ts'

/** Images the browser can show; the preview is only attempted for these names. */
export const isImageName = (name: string) => mediaKindOf(name) === 'image'

/** The address of an attached image on its host, or undefined while loading or if unavailable. */
function useAttachmentSrc(hostKey: string, ref: { id?: string; path?: string }) {
  const [src, setSrc] = useState<string>()
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let live = true
    hostRequest(hostKey, 'attachments.media', ref).then(
      (m) => {
        const route = activeRoute(hostKey)
        const base = route ? httpBase(route) : undefined
        if (live && m && base) setSrc(`${base}${m.url}`)
      },
      () => {},
    )
    return () => {
      live = false
    }
  }, [hostKey, ref.id, ref.path, attempt])
  // The ticket lapses after an hour; one fresh ticket is tried when the picture fails to load.
  return { src, retry: () => attempt < 1 && setAttempt(attempt + 1) }
}

/** A full-size view of an image over the app. Click outside or press Escape to close. */
function Lightbox({ src, name, onClose }: { src: string; name: string; onClose(): void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return createPortal(
    <div className="lightbox" role="dialog" aria-label={name} onClick={onClose}>
      <button className="lightbox-close" aria-label="Close preview" onClick={onClose}>
        <X size={18} />
      </button>
      <img src={src} alt={name} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  )
}

/**
 * A thumbnail of an attached image; click it for the full size. In the transcript it falls back to
 * a plain chip when the host cannot show the picture. `onRemove` adds an X (composer only).
 */
export function AttachmentImage({
  hostKey,
  name,
  id,
  path,
  uploading,
  onRemove,
}: {
  hostKey: string
  name: string
  id?: string
  path?: string
  uploading?: boolean
  onRemove?(): void
}) {
  const { src, retry } = useAttachmentSrc(hostKey, { id, path })
  const [open, setOpen] = useState(false)
  if (!src && !onRemove) {
    return (
      <span className="chip static">
        <Paperclip size={12} /> {name}
      </span>
    )
  }
  return (
    <span className={`thumb ${uploading ? 'uploading' : ''}`} title={name}>
      {src ? (
        <button className="thumb-open" aria-label={`Preview ${name}`} onClick={() => setOpen(true)}>
          <img src={src} alt={name} onError={retry} />
        </button>
      ) : (
        <span className="thumb-open">
          <Paperclip size={14} />
        </span>
      )}
      {onRemove && (
        <button className="thumb-remove" aria-label={`Remove ${name}`} onClick={onRemove}>
          <X size={12} />
        </button>
      )}
      {open && src && <Lightbox src={src} name={name} onClose={() => setOpen(false)} />}
    </span>
  )
}
