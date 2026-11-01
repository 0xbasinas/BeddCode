import { ExtensionContext } from '../context'
import { ExtensionEvent } from '../router'

/** In-memory chrome.storage.session implementation scoped to this browser profile. */
export class StorageAPI {
  private sessionData = new Map<string, Record<string, unknown>>()

  constructor(private ctx: ExtensionContext) {
    const handle = this.ctx.router.apiHandler()
    const storagePermission = { permission: 'storage' }

    handle('storage.session.clear', this.sessionClear, storagePermission)
    handle('storage.session.get', this.sessionGet, storagePermission)
    handle('storage.session.getBytesInUse', this.sessionGetBytesInUse, storagePermission)
    handle('storage.session.getKeys', this.sessionGetKeys, storagePermission)
    handle('storage.session.remove', this.sessionRemove, storagePermission)
    handle('storage.session.set', this.sessionSet, storagePermission)
    handle('storage.session.setAccessLevel', this.sessionSetAccessLevel, storagePermission)

    const sessionExtensions = ctx.session.extensions || ctx.session
    sessionExtensions.on('extension-unloaded', (_event, extension) => {
      this.sessionData.delete(extension.id)
    })
  }

  private getStore(extensionId: string): Record<string, unknown> {
    let store = this.sessionData.get(extensionId)
    if (!store) {
      store = {}
      this.sessionData.set(extensionId, store)
    }
    return store
  }

  private sessionClear = ({ extension }: ExtensionEvent) => {
    const store = this.getStore(extension.id)
    const changes: Record<string, { oldValue: unknown }> = {}
    for (const [key, value] of Object.entries(store)) changes[key] = { oldValue: value }
    this.sessionData.set(extension.id, {})
    if (Object.keys(changes).length)
      this.ctx.router.sendEvent(extension.id, 'storage.session.onChanged', changes)
  }

  private sessionGet = ({ extension }: ExtensionEvent, keys?: unknown) => {
    const store = this.getStore(extension.id)
    const keyList: string[] =
      keys == null
        ? Object.keys(store)
        : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys.filter((key): key is string => typeof key === 'string')
            : typeof keys === 'object'
              ? Object.keys(keys)
              : []
    const result: Record<string, unknown> = {}
    for (const key of keyList) {
      if (Object.hasOwn(store, key)) result[key] = store[key]
      else if (
        keys &&
        typeof keys === 'object' &&
        !Array.isArray(keys) &&
        Object.hasOwn(keys, key)
      ) {
        result[key] = (keys as Record<string, unknown>)[key]
      }
    }
    return result
  }

  private sessionGetBytesInUse = ({ extension }: ExtensionEvent, keys?: unknown) => {
    const store = this.getStore(extension.id)
    const keyList =
      keys == null
        ? Object.keys(store)
        : typeof keys === 'string'
          ? [keys]
          : Array.isArray(keys)
            ? keys.filter((key): key is string => typeof key === 'string')
            : []
    return keyList.reduce((total, key) => {
      const serialized = JSON.stringify(store[key])
      return total + (serialized === undefined ? 0 : key.length + serialized.length)
    }, 0)
  }

  private sessionGetKeys = ({ extension }: ExtensionEvent) =>
    Object.keys(this.getStore(extension.id))

  private sessionRemove = ({ extension }: ExtensionEvent, keys: string | string[]) => {
    const store = this.getStore(extension.id)
    const keyList = typeof keys === 'string' ? [keys] : keys
    const changes: Record<string, { oldValue: unknown }> = {}
    for (const key of keyList) {
      if (Object.hasOwn(store, key)) {
        changes[key] = { oldValue: store[key] }
        delete store[key]
      }
    }
    if (Object.keys(changes).length)
      this.ctx.router.sendEvent(extension.id, 'storage.session.onChanged', changes)
  }

  private sessionSet = ({ extension }: ExtensionEvent, items: Record<string, unknown>) => {
    const store = this.getStore(extension.id)
    const changes: Record<string, { oldValue?: unknown; newValue: unknown }> = {}
    for (const [key, value] of Object.entries(items)) {
      const oldValue = store[key]
      if (oldValue !== undefined && JSON.stringify(oldValue) === JSON.stringify(value)) continue
      store[key] = value
      changes[key] = { ...(oldValue !== undefined && { oldValue }), newValue: value }
    }
    if (Object.keys(changes).length)
      this.ctx.router.sendEvent(extension.id, 'storage.session.onChanged', changes)
  }

  private sessionSetAccessLevel = () => {
    // Extension contexts are isolated from web content in this app; no untrusted-context access
    // mode is exposed by the vendored API.
  }
}
