import { useMemo } from 'react'
import qrcode from 'qrcode-generator'

/** A QR code as inline SVG, always dark on white with a quiet zone so any camera can read it. */
export function QrCode({
  text,
  size = 240,
  label,
}: {
  text: string
  size?: number
  label: string
}) {
  const { path, modules } = useMemo(() => {
    const qr = qrcode(0, 'L')
    qr.addData(text)
    qr.make()
    const count = qr.getModuleCount()
    let d = ''
    for (let y = 0; y < count; y++)
      for (let x = 0; x < count; x++) if (qr.isDark(y, x)) d += `M${x + 2} ${y + 2}h1v1h-1z`
    return { path: d, modules: count + 4 }
  }, [text])
  return (
    <svg
      role="img"
      aria-label={label}
      width={size}
      height={size}
      viewBox={`0 0 ${modules} ${modules}`}
      shapeRendering="crispEdges"
      style={{ borderRadius: 10, background: '#fff', flex: 'none' }}
    >
      <rect width={modules} height={modules} fill="#fff" />
      <path d={path} fill="#111" />
    </svg>
  )
}
