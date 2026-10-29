import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'
import { maskRegions } from './mask.ts'
import { readFields, regionsOf } from './uiaSecrets.ts'

const white = (w: number, h: number) => {
  const png = new PNG({ width: w, height: h })
  png.data.fill(255)
  return { data: PNG.sync.write(png).toString('base64'), mime: 'image/png' }
}
const pixel = (image: { data: string }, x: number, y: number) => {
  const png = PNG.sync.read(Buffer.from(image.data, 'base64'))
  const i = (y * png.width + x) * 4
  return [png.data[i], png.data[i + 1], png.data[i + 2]]
}

describe('maskRegions', () => {
  it('paints the field and a margin black, and leaves the rest', () => {
    const out = maskRegions(white(100, 60), [{ x: 20, y: 20, width: 30, height: 10 }])!
    expect(pixel(out, 30, 25)).toEqual([0, 0, 0])
    expect(pixel(out, 16, 25)).toEqual([0, 0, 0])
    expect(pixel(out, 5, 5)).toEqual([255, 255, 255])
    expect(pixel(out, 90, 55)).toEqual([255, 255, 255])
  })

  it('stays inside the picture for fields at or past its edge', () => {
    const out = maskRegions(white(40, 40), [{ x: -10, y: 30, width: 100, height: 50 }])!
    expect(pixel(out, 0, 39)).toEqual([0, 0, 0])
    expect(pixel(out, 20, 5)).toEqual([255, 255, 255])
  })

  it('gives up on a picture it cannot decode', () => {
    expect(maskRegions({ data: 'bm90IGEgcG5n', mime: 'image/png' }, [])).toBeUndefined()
    expect(maskRegions({ data: 'x', mime: 'image/jpeg' }, [])).toBeUndefined()
  })
})

describe('secret fields from UI Automation', () => {
  const reply = JSON.stringify({
    win: { x: 100, y: 200, w: 400, h: 300 },
    fields: [
      { name: 'Search', password: false, x: 120, y: 220, w: 200, h: 20 },
      { name: 'Password', password: true, x: 120, y: 260, w: 200, h: 20 },
      { name: 'API key', password: false, x: 120, y: 300, w: 200, h: 20 },
    ],
  })

  it('turns screen rectangles into picture regions, scaled', async () => {
    const found = await readFields(7, async () => reply)
    if (!found.ok) throw new Error('expected fields')
    const regions = regionsOf(found, { width: 200, height: 150 }, (l) => /api key/i.test(l))
    expect(regions).toEqual([
      { x: 10, y: 30, width: 100, height: 10 },
      { x: 10, y: 50, width: 100, height: 10 },
    ])
  })

  it('reports a failure instead of throwing', async () => {
    expect((await readFields(7, async () => 'nope')).ok).toBe(false)
    expect(
      (
        await readFields(7, async () => {
          throw new Error('no powershell')
        })
      ).ok,
    ).toBe(false)
    expect(
      (await readFields(7, async () => JSON.stringify({ win: { w: 0, h: 0 }, fields: [] }))).ok,
    ).toBe(false)
  })
})
