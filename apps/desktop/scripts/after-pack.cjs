// electron-builder never copies a folder named node_modules as an extra resource, so the host's
// few runtime packages (the native terminal library and the Claude SDK) are put in place here,
// after the app is laid out and before it is wrapped into an installer.
const { cpSync, existsSync } = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  const from = path.join(__dirname, '..', 'build', 'host', 'server', 'node_modules')
  if (!existsSync(from)) {
    throw new Error('The host is not built. Run: pnpm --filter @beddcode/desktop host')
  }
  const resources =
    context.electronPlatformName === 'darwin'
      ? path.join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents',
          'Resources',
        )
      : path.join(context.appOutDir, 'resources')
  cpSync(from, path.join(resources, 'server', 'node_modules'), { recursive: true })
  console.log(`  • host packages copied to ${path.relative(process.cwd(), resources)}`)
}
