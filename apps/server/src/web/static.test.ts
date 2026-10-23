import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { findWebRoot, resolveStatic, serveWebApp } from './static.ts'

const cleanup: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn()
})

function site() {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-web-')))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(path.join(root, 'assets'))
  writeFileSync(path.join(root, 'index.html'), '<html>app</html>')
  writeFileSync(path.join(root, 'assets', 'app-abc123.js'), 'console.log(1)')
  writeFileSync(path.join(root, 'favicon.svg'), '<svg/>')
  // A secret next to the site, which no request may reach.
  writeFileSync(path.join(path.dirname(root), `${path.basename(root)}-secret.txt`), 'secret')
  cleanup.push(() =>
    rmSync(path.join(path.dirname(root), `${path.basename(root)}-secret.txt`), { force: true }),
  )
  return root
}

describe('resolveStatic', () => {
  it('finds files and folders with an index inside the root', () => {
    const root = site()
    expect(resolveStatic(root, '/assets/app-abc123.js')).toBe(
      path.join(root, 'assets', 'app-abc123.js'),
    )
    expect(resolveStatic(root, '/')).toBe(path.join(root, 'index.html'))
    expect(resolveStatic(root, '/nope.js')).toBeUndefined()
  })

  it('never leaves the root', () => {
    const root = site()
    const secret = `${path.basename(root)}-secret.txt`
    for (const attack of [
      `/../${secret}`,
      `/..%2F${secret}`,
      `/%2e%2e/${secret}`,
      `/assets/../../${secret}`,
      '/a\0b',
      '/%',
    ]) {
      expect(resolveStatic(root, attack)).toBeUndefined()
    }
  })
})

describe('serveWebApp', () => {
  async function serve(root: string) {
    const server: Server = createServer((req, res) => {
      const url = (req.url ?? '/').split('?')[0]!
      if (!serveWebApp(root, req, res, url)) res.writeHead(404).end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(() => new Promise<void>((r) => server.close(() => r())))
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`
  }

  it('serves the page fresh and the hashed assets for good, with the right types', async () => {
    const base = await serve(site())
    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    expect(page.headers.get('cache-control')).toBe('no-cache')
    expect(await page.text()).toBe('<html>app</html>')
    const asset = await fetch(`${base}/assets/app-abc123.js`)
    expect(asset.headers.get('content-type')).toContain('text/javascript')
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${base}/favicon.svg`)).headers.get('content-type')).toBe('image/svg+xml')
  })

  it('gives the app page to a path with no file (it routes in the browser), but not a missing file', async () => {
    const base = await serve(site())
    expect(await (await fetch(`${base}/session/abc`)).text()).toBe('<html>app</html>')
    expect((await fetch(`${base}/assets/missing.js`)).status).toBe(404)
  })

  it('answers HEAD without a body, and leaves other methods alone', async () => {
    const base = await serve(site())
    const head = await fetch(`${base}/`, { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect((await head.arrayBuffer()).byteLength).toBe(0)
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(404)
  })

  it('does not hand out files outside the root', async () => {
    const root = site()
    const base = await serve(root)
    const res = await fetch(`${base}/..%2F${path.basename(root)}-secret.txt`)
    expect(await res.text()).not.toContain('secret')
  })
})

describe('findWebRoot', () => {
  it('takes the folder named in BEDDCODE_WEB_ROOT when it holds the app', () => {
    const root = site()
    expect(findWebRoot({ BEDDCODE_WEB_ROOT: root })).toBe(root)
  })

  it('ignores a folder that has no index page', () => {
    const empty = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), 'beddcode-empty-')))
    cleanup.push(() => rmSync(empty, { recursive: true, force: true }))
    expect(findWebRoot({ BEDDCODE_WEB_ROOT: empty })).not.toBe(empty)
  })
})
