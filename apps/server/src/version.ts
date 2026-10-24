// Set when the host is bundled for the installer (see apps/desktop/scripts/build-host.mjs), so the
// host reports the app's own version. From a checkout it says so.
declare const __BEDDCODE_VERSION__: string | undefined

export const VERSION: string =
  typeof __BEDDCODE_VERSION__ === 'string' ? __BEDDCODE_VERSION__ : '0.0.0-dev'
