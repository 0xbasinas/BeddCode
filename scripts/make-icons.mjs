// Renders the app icons from assets/logo/mark.svg:
//   node scripts/make-icons.mjs
// Writes PNG sizes and a Windows .ico under assets/icons, the web favicon files, and the images the
// desktop app (and later its installers) use. Run it again after changing the logo.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svg = readFileSync(path.join(root, 'assets/logo/mark.svg'), 'utf8')

const png = (size) => new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()

const out = (relative, data) => {
  const file = path.join(root, relative)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, data)
  console.log(relative)
}

/** An .ico holding PNG images, which every Windows since Vista reads. */
function ico(sizes) {
  const images = sizes.map((size) => ({ size, data: png(size) }))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)
  const entries = Buffer.alloc(16 * images.length)
  let offset = header.length + entries.length
  images.forEach(({ size, data }, i) => {
    const at = i * 16
    entries[at] = size === 256 ? 0 : size
    entries[at + 1] = size === 256 ? 0 : size
    entries.writeUInt16LE(1, at + 4) // colour planes
    entries.writeUInt16LE(32, at + 6) // bits per pixel
    entries.writeUInt32LE(data.length, at + 8)
    entries.writeUInt32LE(offset, at + 12)
    offset += data.length
  })
  return Buffer.concat([header, entries, ...images.map((i) => i.data)])
}

for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) {
  out(`assets/icons/icon-${size}.png`, png(size))
}
out('assets/icons/icon.ico', ico([16, 24, 32, 48, 64, 128, 256]))

// Web: the favicon is the vector mark itself, with a PNG for places that ask for one.
out('apps/web/public/favicon.svg', svg)
out('apps/web/public/favicon.ico', ico([16, 32, 48]))
out('apps/web/public/icon-192.png', png(192))
out('apps/web/public/icon-512.png', png(512))

// Desktop: the window icon, and the sizes installers take (electron-builder reads build/).
out('apps/desktop/build/icon.png', png(512))
out('apps/desktop/build/icon.ico', ico([16, 24, 32, 48, 64, 128, 256]))
// Linux installers take a folder of sizes named NxN.png.
for (const size of [16, 32, 48, 64, 128, 256, 512]) {
  out(`apps/desktop/build/icons/${size}x${size}.png`, png(size))
}
