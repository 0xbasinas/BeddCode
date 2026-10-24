import type { BrowserCommand, BrowserRect } from '@beddcode/contracts'

// The app page is trusted, but whatever crosses IPC is checked for shape before the main process
// acts on it: a bug there should fail closed, not reach WebContents with garbage.

type Raw = Record<string, unknown>

const isTab = (v: unknown): v is number => Number.isInteger(v) && (v as number) > 0
const isText = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length <= max
const optText = (v: unknown, max?: number) => v === undefined || isText(v, max)

function rect(v: unknown): BrowserRect | null | undefined {
  if (v === null) return null
  if (typeof v !== 'object' || v === undefined) return undefined
  const { x, y, width, height } = v as Raw
  const nums = [x, y, width, height]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  return { x: x as number, y: y as number, width: width as number, height: height as number }
}

const TAB_OPS = new Set([
  'back',
  'forward',
  'reload',
  'hard-reload',
  'stop',
  'devtools',
  'focus',
  'close',
  'stop-find',
  'pdf',
  'console',
  'clear-console',
])

/** The command, when it is a well-formed one; null otherwise. */
export function parseBrowserCommand(raw: unknown): BrowserCommand | null {
  if (typeof raw !== 'object' || raw === null) return null
  const c = raw as Raw
  const op = c.op
  if (typeof op !== 'string') return null
  if (TAB_OPS.has(op)) return isTab(c.tabId) ? ({ op, tabId: c.tabId } as BrowserCommand) : null
  switch (op) {
    case 'ensure':
    case 'navigate':
      return isTab(c.tabId) && isText(c.url) ? { op, tabId: c.tabId, url: c.url } : null
    case 'layout': {
      const bounds = rect(c.bounds)
      if (bounds === undefined || !(c.tabId === null || isTab(c.tabId))) return null
      const radius =
        typeof c.radius === 'number' && Number.isFinite(c.radius)
          ? Math.min(64, Math.max(0, c.radius))
          : 0
      return { op, tabId: c.tabId, bounds, radius }
    }
    case 'zoom':
      return isTab(c.tabId) && (c.direction === -1 || c.direction === 0 || c.direction === 1)
        ? { op, tabId: c.tabId, direction: c.direction }
        : null
    case 'find':
      if (!isTab(c.tabId) || !isText(c.text, 1000)) return null
      return {
        op,
        tabId: c.tabId,
        text: c.text,
        forward: c.forward !== false,
        next: c.next === true,
      }
    case 'capture': {
      if (!isTab(c.tabId)) return null
      if (c.rect === undefined) return { op, tabId: c.tabId }
      const r = rect(c.rect)
      return r ? { op, tabId: c.tabId, rect: r } : null
    }
    case 'exec':
      return isTab(c.tabId) && isText(c.code, 200_000) ? { op, tabId: c.tabId, code: c.code } : null
    case 'permission':
      return isText(c.id, 64) && typeof c.allow === 'boolean'
        ? { op, id: c.id, allow: c.allow }
        : null
    case 'login':
      if (!isText(c.id, 64) || !optText(c.username, 1024) || !optText(c.password, 1024)) return null
      return {
        op,
        id: c.id,
        username: c.username as string | undefined,
        password: c.password as string | undefined,
      }
    case 'reveal-download':
      return isText(c.id, 64) ? { op, id: c.id } : null
    case 'open-external':
      return isText(c.url) && /^https?:\/\//i.test(c.url) ? { op, url: c.url } : null
    case 'forward-port':
      if (!isText(c.route, 2048) || !optText(c.token, 4096)) return null
      if (!Number.isInteger(c.port) || (c.port as number) < 1 || (c.port as number) > 65535)
        return null
      return {
        op,
        route: c.route,
        token: c.token as string | undefined,
        port: c.port as number,
      }
    case 'clear-data':
      return { op }
    default:
      return null
  }
}
