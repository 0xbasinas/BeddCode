import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { unzipSync } from 'fflate'

export interface StoredBrowserExtension {
  key: string
  name: string
  path: string
  electronId: string
  enabled?: boolean
  actionPage?: string
  settingsPage?: string
  sourceBrowserId?: string
}

export interface InstalledExtensionSource {
  id: string
  name: string
  path: string
}

/** Resolve the manifest's Chrome-style localized extension name when possible. */
export async function localizedExtensionName(
  directory: string,
  fallback = '',
): Promise<string> {
  try {
    const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as {
      name?: unknown
      default_locale?: unknown
    }
    const raw = typeof manifest.name === 'string' ? manifest.name : ''
    const match = /^__MSG_(.+)__$/i.exec(raw)
    if (match && typeof manifest.default_locale === 'string') {
      const messages = JSON.parse(
        await readFile(
          path.join(directory, '_locales', manifest.default_locale, 'messages.json'),
          'utf8',
        ),
      ) as Record<string, { message?: unknown }>
      const key = Object.keys(messages).find(
        (candidate) => candidate.toLowerCase() === match[1]!.toLowerCase(),
      )
      const resolved = key && messages[key]?.message
      if (typeof resolved === 'string' && resolved.trim()) return resolved.trim().slice(0, 100)
    }
    if (raw && !match) return raw.slice(0, 100)
  } catch {
    // Older or incomplete extension packages may not include locale metadata.
  }
  return fallback.slice(0, 100)
}

/**
 * Proton Pass uses chrome.identity.launchWebAuthFlow for its OAuth sign-in. Electron does not
 * implement chrome.identity, so add a small profile-local compatibility shim that routes the
 * OAuth window through this app's own extension window/tab APIs.
 */
export async function prepareExtensionIdentityCompatibility(directory: string): Promise<void> {
  const manifestPath = path.join(directory, 'manifest.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
    name?: unknown
    permissions?: unknown
    background?: { scripts?: unknown; service_worker?: unknown; type?: unknown }
  }
  const extensionName = typeof manifest.name === 'string' ? manifest.name.toLowerCase() : ''
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : []
  if (!extensionName.includes('proton pass') && !permissions.includes('identity')) return
  const background = manifest.background
  if (!background) return

  const shimName = 'beddcode-identity-compat.js'
  const shimPath = path.join(directory, shimName)
  const completePageName = 'beddcode-auth-complete.html'
  const completeScriptName = 'beddcode-auth-complete.js'
  const shim = `(() => {
  const chromeApi = globalThis.chrome;
  if (!chromeApi?.runtime?.id || !chromeApi.windows?.create || !chromeApi.runtime?.onMessage) return;
  const identity = chromeApi.identity || {};
  const redirectBase = 'https://' + chromeApi.runtime.id + '.chromiumapp.org/';
  const pendingFlows = new Set();
  identity.getRedirectURL = (path = '') => redirectBase + String(path).replace(/^\\/+/, '');
  chromeApi.runtime.onMessage.addListener((message, sender) => {
    if (sender?.id !== chromeApi.runtime.id || message?.__beddcodeIdentityRedirect !== true) return;
    const url = message.url;
    if (typeof url !== 'string') return;
    for (const flow of pendingFlows) {
      if (url.startsWith(flow.redirectUrl)) flow.finish(null, url);
    }
  });
  identity.launchWebAuthFlow = (details, callback) => {
    const promise = new Promise((resolve, reject) => {
      if (!details || typeof details.url !== 'string' || !/^https:\\/\\//i.test(details.url)) {
        reject(new Error('Sign-in requires a secure HTTPS URL.'));
        return;
      }
      let windowId;
      let settled = false;
      const redirectUrl = identity.getRedirectURL();
      const flow = { redirectUrl, finish: () => {} };
      const cleanup = () => {
        clearTimeout(timeout);
        chromeApi.windows.onRemoved?.removeListener(onRemoved);
      };
      const finish = (error, url) => {
        if (settled) return;
        settled = true;
        pendingFlows.delete(flow);
        cleanup();
        if (typeof windowId === 'number') chromeApi.windows.remove(windowId, () => {});
        if (error) reject(error); else resolve(url);
      };
      flow.finish = finish;
      const onRemoved = (removedId) => {
        if (removedId === windowId) finish(new Error('The sign-in window was closed.'));
      };
      const timeout = setTimeout(() => finish(new Error('Sign-in timed out.')), 5 * 60 * 1000);
      pendingFlows.add(flow);
      chromeApi.windows.onRemoved?.addListener(onRemoved);
      chromeApi.windows.create({
        url: details.url,
        type: 'popup',
        focused: true,
        width: 520,
        height: 700,
      }, (window) => {
        if (!window || typeof window.id !== 'number') {
          finish(new Error('Could not open the sign-in window.'));
          return;
        }
        windowId = window.id;
      });
    });
    if (typeof callback === 'function') {
      promise.then((url) => callback(url), () => callback());
    }
    return promise;
  };
  chromeApi.identity = identity;
})();\n`
  await writeFile(shimPath, shim, 'utf8')
  await writeFile(
    path.join(directory, completePageName),
    '<!doctype html><html><head><meta charset="utf-8"><title>Sign-in complete</title></head><body><p>Sign-in complete. You can close this window.</p><script src="beddcode-auth-complete.js"></script></body></html>',
    'utf8',
  )
  await writeFile(
    path.join(directory, completeScriptName),
    `const url = new URL(location.href).searchParams.get('url');\nif (url) chrome.runtime.sendMessage({ __beddcodeIdentityRedirect: true, url });\n`,
    'utf8',
  )

  let changed = false
  if (Array.isArray(background.scripts)) {
    if (!background.scripts.includes(shimName)) {
      background.scripts.unshift(shimName)
      changed = true
    }
  } else if (typeof background.service_worker === 'string') {
    const workerPath = path.join(directory, background.service_worker)
    const original = await readFile(workerPath, 'utf8')
    const marker = '/* BeddCode Proton identity compatibility */'
    if (!original.includes(marker)) {
      const prefix = background.type === 'module'
        ? `import './${shimName}';\n${marker}\n`
        : `importScripts('./${shimName}');\n${marker}\n`
      await writeFile(workerPath, prefix + original, 'utf8')
    }
  } else {
    return
  }
  if (!permissions.includes('identity')) {
    manifest.permissions = [...permissions, 'identity']
    changed = true
  }
  if (changed) await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
}

function safeManifestPage(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  const normalized = path.posix.normalize(value.replace(/\\/g, '/').replace(/^\/+/, ''))
  return normalized === '..' || normalized.startsWith('../') || normalized.includes(':')
    ? undefined
    : normalized
}

export async function extensionPagesAt(directory: string): Promise<{
  actionPage?: string
  settingsPage?: string
}> {
  const manifest = JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')) as {
    action?: { default_popup?: unknown }
    browser_action?: { default_popup?: unknown }
    page_action?: { default_popup?: unknown }
    options_ui?: { page?: unknown }
    options_page?: unknown
  }
  const actionPage = safeManifestPage(
    manifest.action?.default_popup ??
      manifest.browser_action?.default_popup ??
      manifest.page_action?.default_popup,
  )
  const settingsPage = safeManifestPage(manifest.options_ui?.page ?? manifest.options_page)
  return {
    ...(actionPage && { actionPage }),
    ...(settingsPage && { settingsPage }),
  }
}

/** Lists active WebExtensions from Firefox's profile registry (including packaged XPI files). */
export async function installedFirefoxExtensions(
  profilePath: string,
): Promise<InstalledExtensionSource[]> {
  const registry = JSON.parse(
    await readFile(path.join(profilePath, 'extensions.json'), 'utf8'),
  ) as {
    addons?: Array<{
      id?: unknown
      name?: unknown
      active?: unknown
      type?: unknown
      path?: unknown
      location?: unknown
      appDisabled?: unknown
      isBuiltin?: unknown
    }>
  }
  return (registry.addons ?? []).flatMap((addon) => {
    if (addon.active !== true || addon.type !== 'extension' || addon.appDisabled === true) return []
    if (typeof addon.path !== 'string' || !addon.path) return []
    const resolvedPath = path.resolve(profilePath, addon.path)
    const root = path.resolve(profilePath).toLowerCase()
    if (!resolvedPath.toLowerCase().startsWith(`${root}${path.sep.toLowerCase()}`)) return []
    const id = typeof addon.id === 'string' ? addon.id : path.basename(resolvedPath, '.xpi')
    const name = typeof addon.name === 'string' ? addon.name : id
    return [{ id, name, path: resolvedPath }]
  })
}

/** Reads enabled extensions from Chromium's regular or secure profile preferences. */
export async function installedExtensionsInProfile(
  profilePath: string,
): Promise<InstalledExtensionSource[]> {
  const profile = path.resolve(profilePath)
  const extensionRoot = path.join(profile, 'Extensions')
  type ExtensionPreference = {
    state?: unknown
    disable_reasons?: unknown
    location?: unknown
    path?: unknown
    manifest?: { version?: unknown }
  }
  const readSettings = async (file: string): Promise<Record<string, ExtensionPreference>> => {
    try {
      const preferences = JSON.parse(await readFile(path.join(profile, file), 'utf8')) as {
        extensions?: { settings?: Record<string, ExtensionPreference> }
      }
      return preferences.extensions?.settings ?? {}
    } catch {
      return {}
    }
  }
  const settings = {
    ...(await readSettings('Preferences')),
    ...(await readSettings('Secure Preferences')),
  }
  const result: InstalledExtensionSource[] = []
  for (const [id, setting] of Object.entries(settings)) {
    const modernEnabled =
      setting.state === undefined &&
      Number(setting.location) === 1 &&
      (!Array.isArray(setting.disable_reasons) || setting.disable_reasons.length === 0)
    if ((setting.state !== 1 && !modernEnabled) || !/^[a-p]{32}$/.test(id)) continue
    const rawPath = typeof setting.path === 'string' ? setting.path : ''
    const recordedPath = rawPath
      ? path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(profile, rawPath)
      : ''
    const isWithinExtensionRoot = recordedPath
      .toLowerCase()
      .startsWith(`${path.resolve(extensionRoot).toLowerCase()}${path.sep.toLowerCase()}`)
    const candidateDirs: string[] = []
    if (isWithinExtensionRoot) candidateDirs.push(recordedPath)
    const version = typeof setting.manifest?.version === 'string' ? setting.manifest.version : ''
    if (version) candidateDirs.push(path.join(extensionRoot, id, version))
    const versions = await readdir(path.join(extensionRoot, id), { withFileTypes: true }).catch(
      () => [],
    )
    candidateDirs.push(
      ...versions
        .filter(
          (entry) => entry.isDirectory() && (!version || entry.name.startsWith(`${version}_`)),
        )
        .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))
        .map((entry) => path.join(extensionRoot, id, entry.name)),
    )
    for (const directory of candidateDirs) {
      try {
        const manifest = JSON.parse(
          await readFile(path.join(directory, 'manifest.json'), 'utf8'),
        ) as {
          name?: unknown
          manifest_version?: unknown
        }
        if (![2, 3].includes(Number(manifest.manifest_version))) break
        const name = await localizedExtensionName(directory, id)
        result.push({ id, name, path: directory })
        break
      } catch {
        // An extension can be updating while Chrome is open; try its next installed version.
      }
    }
  }
  return result
}

/** Copies one explicitly chosen unpacked extension into app storage for the selected profile. */
export async function copyUnpackedExtension(
  sourcePath: string,
  destinationRoot: string,
): Promise<Omit<StoredBrowserExtension, 'electronId'>> {
  const source = path.resolve(sourcePath)
  const key = randomUUID()
  const target = path.join(destinationRoot, key)
  await mkdir(destinationRoot, { recursive: true })
  if (source.toLowerCase().endsWith('.xpi')) {
    const archive = unzipSync(await readFile(source))
    let entries = 0
    for (const [archiveName, contents] of Object.entries(archive)) {
      const normalized = archiveName.replace(/\\/g, '/')
      const relative = path.posix.normalize(normalized)
      if (relative === '.' || relative.startsWith('../') || path.posix.isAbsolute(relative))
        throw new Error('This Firefox extension archive contains an unsafe file path.')
      const destination = path.resolve(target, ...relative.split('/'))
      if (destination !== target && !destination.startsWith(`${target}${path.sep}`))
        throw new Error('This Firefox extension archive contains an unsafe file path.')
      if (archiveName.endsWith('/')) {
        await mkdir(destination, { recursive: true })
      } else {
        await mkdir(path.dirname(destination), { recursive: true })
        await writeFile(destination, contents)
        entries++
      }
    }
    if (!entries) throw new Error('This Firefox extension archive is empty.')
  } else {
    await cp(source, target, { recursive: true, force: false, errorOnExist: true })
  }
  let manifest: {
    name?: unknown
    manifest_version?: unknown
    action?: { default_popup?: unknown }
    browser_action?: { default_popup?: unknown }
    page_action?: { default_popup?: unknown }
    options_ui?: { page?: unknown }
    options_page?: unknown
  }
  try {
    manifest = JSON.parse(await readFile(path.join(target, 'manifest.json'), 'utf8'))
  } catch {
    await rm(target, { recursive: true, force: true })
    throw new Error('Choose an unpacked extension folder containing manifest.json.')
  }
  if (![2, 3].includes(Number(manifest.manifest_version))) {
    await rm(target, { recursive: true, force: true })
    throw new Error('This extension uses an unsupported manifest version.')
  }
  const name = await localizedExtensionName(target, path.basename(source, '.xpi'))
  if (!name) {
    await rm(target, { recursive: true, force: true })
    throw new Error('The extension manifest has no name.')
  }
  const actionPage = safeManifestPage(
    manifest.action?.default_popup ??
      manifest.browser_action?.default_popup ??
      manifest.page_action?.default_popup,
  )
  const settingsPage = safeManifestPage(manifest.options_ui?.page ?? manifest.options_page)
  return {
    key,
    name: name.slice(0, 100),
    path: target,
    enabled: true,
    ...(actionPage && { actionPage }),
    ...(settingsPage && { settingsPage }),
  }
}

/** Copies only this Chromium extension's persistent data stores into an isolated app profile. */
export async function copyChromiumExtensionData(
  sourceProfile: string,
  destinationProfile: string,
  extensionId: string,
): Promise<number> {
  if (!/^[a-p]{32}$/.test(extensionId)) return 0
  const stores = [
    ['Local Extension Settings', extensionId],
    ['Sync Extension Settings', extensionId],
    ['IndexedDB', `chrome-extension_${extensionId}_0.indexeddb.leveldb`],
  ] as const
  let copied = 0
  for (const [directory, name] of stores) {
    const source = path.join(path.resolve(sourceProfile), directory, name)
    const destination = path.join(path.resolve(destinationProfile), directory, name)
    try {
      if (!(await stat(source)).isDirectory()) continue
      await mkdir(path.dirname(destination), { recursive: true })
      await cp(source, destination, { recursive: true, force: false, errorOnExist: true })
      copied++
    } catch {
      // This store may not exist, or the source browser may have it locked. Keep the extension
      // import usable and let the caller report that sign-in data could not be copied.
    }
  }
  return copied
}
