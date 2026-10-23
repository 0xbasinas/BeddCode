import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
}

/**
 * Where the built web app is: `BEDDCODE_WEB_ROOT`, else `apps/web/dist` in the source tree. Undefined
 * when there is none (a host that only serves the API).
 */
export function findWebRoot(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const candidates = [
    env.BEDDCODE_WEB_ROOT,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../web/dist'),
  ]
  return candidates.find((dir): dir is string => !!dir && existsSync(path.join(dir, 'index.html')))
}

/** The file a request path names inside `root`, or undefined when it names nothing inside it. */
export function resolveStatic(root: string, urlPath: string): string | undefined {
  let decoded: string
  try {
    decoded = decodeURIComponent(urlPath)
  } catch {
    return undefined
  }
  if (decoded.includes('\0')) return undefined
  const target = path.resolve(root, `.${path.posix.normalize(`/${decoded}`)}`)
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) return undefined
  try {
    const info = statSync(target)
    if (info.isDirectory()) {
      const index = path.join(target, 'index.html')
      return existsSync(index) ? index : undefined
    }
    return info.isFile() ? target : undefined
  } catch {
    return undefined
  }
}

/**
 * Serves the built web app so the desktop app (and a browser on this machine or the tailnet) loads
 * it from the host itself. The app talks back to the same address, so no origin has to be allowed.
 * A path that names no file gets the app's own page, which routes in the browser. Returns false
 * when the request is not for the web app at all.
 */
export function serveWebApp(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  urlPath: string,
): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false
  // Anything with an extension that is missing is a missing file, not a page to route.
  const file =
    resolveStatic(root, urlPath) ??
    (path.extname(urlPath) === '' ? path.join(root, 'index.html') : undefined)
  if (!file || !existsSync(file)) return false

  const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  const info = statSync(file)
  const isPage = file.endsWith('.html')
  res.writeHead(200, {
    'content-type': type,
    'content-length': info.size,
    // Built assets carry a content hash in their name; the page itself must stay fresh.
    'cache-control': isPage ? 'no-cache' : 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
  })
  if (req.method === 'HEAD') res.end()
  else createReadStream(file).pipe(res)
  return true
}
