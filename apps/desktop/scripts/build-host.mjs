// Builds the host into one folder the installer can ship:
//   node apps/desktop/scripts/build-host.mjs [--out apps/desktop/build/host]
//
// The host's own code and its pure-JavaScript dependencies are bundled into server/main.mjs. A few
// packages stay outside the bundle because they carry native code or their own program files; they
// are installed next to it (for the platform this runs on), so each operating system builds its own
// installer. The built web app goes beside it as web/.
import { execFileSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const outArg = process.argv.indexOf('--out')
const out = path.resolve(root, outArg > 0 ? process.argv[outArg + 1] : 'apps/desktop/build/host')

/** Packages the bundle leaves out, and why. */
const EXTERNAL = [
  // Prebuilt native terminal library, with a separate package per platform.
  '@lydell/node-pty',
  // Starts the Claude Code program that ships in its own platform package.
  '@anthropic-ai/claude-agent-sdk',
  // Optional native speedups of `ws`; it falls back to JavaScript without them.
  'bufferutil',
  'utf-8-validate',
  // Native desktop-automation library for computer use (Windows hosts); the host loads it on demand
  // by name (apps/server/src/computer/cuaDriver.ts), so the bundler never sees it.
  '@trycua/cua-driver',
]

const appVersion = JSON.parse(
  readFileSync(path.join(root, 'apps/desktop/package.json'), 'utf8'),
).version
const serverDir = path.join(root, 'apps/server')
const requireFromServer = createRequire(path.join(serverDir, 'package.json'))
const requireFromClaude = createRequire(path.join(root, 'packages/provider-claude/package.json'))

/** The version actually installed in the workspace, so the shipped one is the one that was tested. */
function installedVersion(name, requireFrom) {
  let dir = path.dirname(requireFrom.resolve(name))
  // Walk up to the package's own folder (its package.json carries the name).
  for (;;) {
    const file = path.join(dir, 'package.json')
    if (existsSync(file)) {
      const pkg = JSON.parse(readFileSync(file, 'utf8'))
      if (pkg.name === name) return pkg.version
    }
    const parent = path.dirname(dir)
    if (parent === dir) throw new Error(`Cannot find ${name}`)
    dir = parent
  }
}

console.log(`host -> ${path.relative(root, out)}`)
rmSync(out, { recursive: true, force: true, maxRetries: 20, retryDelay: 300 })
mkdirSync(path.join(out, 'server'), { recursive: true })

await build({
  entryPoints: [path.join(serverDir, 'src/main.ts')],
  outfile: path.join(out, 'server/main.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: EXTERNAL,
  // Some bundled CommonJS packages call require() and look for __dirname.
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module'",
      "import { fileURLToPath as __fileURLToPath } from 'node:url'",
      "import { dirname as __dirname_of } from 'node:path'",
      'const require = __createRequire(import.meta.url)',
      'const __filename = __fileURLToPath(import.meta.url)',
      'const __dirname = __dirname_of(__filename)',
    ].join('\n'),
  },
  // The host reports the app's own version (see apps/server/src/version.ts).
  define: { __BEDDCODE_VERSION__: JSON.stringify(appVersion) },
  legalComments: 'none',
  logLevel: 'warning',
})

// What stays outside, installed beside the bundle for this platform.
const dependencies = {
  '@lydell/node-pty': installedVersion('@lydell/node-pty', requireFromServer),
  '@anthropic-ai/claude-agent-sdk': installedVersion(
    '@anthropic-ai/claude-agent-sdk',
    requireFromClaude,
  ),
}
// Computer use runs on Windows and Linux hosts; its library and per-platform binary (about 11 MB)
// are left out of macOS installers.
if (process.platform === 'win32' || process.platform === 'linux') {
  // Its exports allow only `import`, so the version is read from the package file itself.
  const pkgFile = path.join(serverDir, 'node_modules/@trycua/cua-driver/package.json')
  dependencies['@trycua/cua-driver'] = JSON.parse(readFileSync(pkgFile, 'utf8')).version
}
writeFileSync(
  path.join(out, 'server/package.json'),
  JSON.stringify({ name: 'beddcode-host', private: true, type: 'module', dependencies }, null, 2),
)
console.log(
  'installing',
  Object.entries(dependencies)
    .map(([n, v]) => `${n}@${v}`)
    .join(', '),
)
execFileSync(
  process.platform === 'win32' ? 'npm.cmd' : 'npm',
  ['install', '--omit=dev', '--no-audit', '--no-fund', '--no-package-lock', '--loglevel=error'],
  { cwd: path.join(out, 'server'), stdio: 'inherit', shell: process.platform === 'win32' },
)

// The SDK brings its own copy of the Claude Code program (hundreds of megabytes). BeddCode always
// starts the Claude Code the user has installed and signed in, so that copy is never used.
const sdkScope = path.join(out, 'server/node_modules/@anthropic-ai')
if (existsSync(sdkScope)) {
  for (const name of readdirSync(sdkScope)) {
    if (name.startsWith('claude-agent-sdk-'))
      rmSync(path.join(sdkScope, name), { recursive: true, force: true })
  }
}

// The web app the host serves.
const web = path.join(root, 'apps/web/dist')
if (!existsSync(path.join(web, 'index.html'))) {
  throw new Error('Build the web app first: pnpm --filter @beddcode/web build')
}
cpSync(web, path.join(out, 'web'), { recursive: true })
console.log('done')
