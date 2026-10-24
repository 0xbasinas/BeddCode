import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Hosts can be on any machine, and the browser pane and attached media come from anywhere, so
// connections, images and frames stay open to the network; what is locked down is code: scripts
// only from the app itself, no eval, no plugins, no re-pointing of the page's base or forms.
const policy = (dev: boolean) =>
  [
    "default-src 'self'",
    // Vite's dev server injects an inline script for hot reload; the built app has none.
    `script-src 'self'${dev ? " 'unsafe-inline'" : ''}`,
    // React style attributes and CodeMirror's own style elements.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "media-src 'self' blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss: http: https:",
    "worker-src 'self' blob:",
    'frame-src http: https:',
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ')

function contentSecurityPolicy(): Plugin {
  let dev = true
  return {
    name: 'beddcode-csp',
    configResolved: (config) => void (dev = config.command === 'serve'),
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: policy(dev) },
        injectTo: 'head-prepend',
      },
    ],
  }
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  // Relative base so the Electron build can load dist/index.html from disk.
  base: './',
  server: { port: 5173, strictPort: true },
})
