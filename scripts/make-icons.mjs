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

// Mobile (Expo): the store icon, the Android adaptive layers and the splash image.
const glyphPath = svg.match(/<path\s+fill="#171717"\s+d="([^"]+)"/)?.[1]
if (!glyphPath) throw new Error('mark.svg changed: could not find the B outline')
const details = `<rect x="108" y="77" width="30" height="14" rx="7" fill="#f2ab3c" />
  <path d="M114.5 150 L131.5 164 L114.5 178" fill="none" stroke="#f2ab3c" stroke-width="13" stroke-linecap="round" stroke-linejoin="round" />`
const gradient = `<defs><linearGradient id="tile" x1="30" y1="0" x2="226" y2="256" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#f8c46a" /><stop offset="1" stop-color="#e08a1a" /></linearGradient></defs>`
const render = (markup, size) =>
  new Resvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">${markup}</svg>`, {
    fitTo: { mode: 'width', value: size },
  })
    .render()
    .asPng()
/** The letter alone, centred, scaled about the middle of the tile. */
const glyph = (scale, body) =>
  `<g transform="translate(128 128) scale(${scale}) translate(-128 -128)">${body}</g>`
const letter = `<path fill="#171717" d="${glyphPath}" />${details}`

const images = 'apps/mobile/assets/images'
// Stores round the corners themselves, so the icon is a full square.
out(
  `${images}/icon.png`,
  render(
    `${gradient}<rect width="256" height="256" fill="url(#tile)" />${glyph(1.08, letter)}`,
    1024,
  ),
)
// Android adaptive icon: the system masks these, keeping the middle two thirds visible.
out(
  `${images}/android-icon-background.png`,
  render(`${gradient}<rect width="256" height="256" fill="url(#tile)" />`, 1024),
)
out(`${images}/android-icon-foreground.png`, render(glyph(0.95, letter), 1024))
// Themed icons use only the shape: the letter with its window and prompt cut out.
const cutMask = `<mask id="cut"><rect width="256" height="256" fill="black" /><path fill="white" d="${glyphPath}" />${details.replaceAll('#f2ab3c', 'black')}</mask><rect width="256" height="256" fill="white" mask="url(#cut)" />`
out(`${images}/android-icon-monochrome.png`, render(glyph(0.95, cutMask), 1024))
// The splash shows the rounded mark on the app's dark background (set in app.json).
out(`${images}/splash-icon.png`, png(1024))
out(`${images}/favicon.png`, png(48))
