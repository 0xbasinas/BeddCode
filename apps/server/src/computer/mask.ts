import { PNG } from 'pngjs'
import type { DesktopImage } from './driver.ts'

/** A rectangle in picture pixels. */
export interface Region {
  x: number
  y: number
  width: number
  height: number
}

const PAD = 6

/**
 * Paints black over the regions of a PNG (secret fields), a few pixels wider than the field so
 * its edges and a caret do not show. Undefined when the picture cannot be decoded: the caller then
 * withholds it instead.
 */
export function maskRegions(image: DesktopImage, regions: Region[]): DesktopImage | undefined {
  if (image.mime !== 'image/png') return undefined
  try {
    const png = PNG.sync.read(Buffer.from(image.data, 'base64'))
    for (const r of regions) {
      const x0 = Math.max(0, Math.floor(r.x - PAD))
      const y0 = Math.max(0, Math.floor(r.y - PAD))
      const x1 = Math.min(png.width, Math.ceil(r.x + r.width + PAD))
      const y1 = Math.min(png.height, Math.ceil(r.y + r.height + PAD))
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * png.width + x) * 4
          png.data[i] = 0
          png.data[i + 1] = 0
          png.data[i + 2] = 0
          png.data[i + 3] = 255
        }
      }
    }
    return { data: PNG.sync.write(png).toString('base64'), mime: 'image/png' }
  } catch {
    return undefined
  }
}
