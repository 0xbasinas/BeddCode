import { JsonRpcError } from '@beddcode/shared'

/**
 * Whether an error from an agent means "that conversation does not exist (any more)". Agents word
 * this in many ways, so the code, the message and anything nested in the error's data are all read.
 * Adapted from acpx's `isAcpResourceNotFoundError` (https://github.com/openclaw/acpx, MIT).
 */

/** ACP resource-not-found codes: the spec's -32002 and the -32001 several agents use. */
const NOT_FOUND_CODES = new Set([-32001, -32002])

const SESSION_NOT_FOUND = /session\s+["'\w-]+\s+not found/i

function isNotFoundText(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const text = value.toLowerCase()
  return (
    text.includes('resource_not_found') ||
    text.includes('resource not found') ||
    text.includes('session not found') ||
    text.includes('unknown session') ||
    text.includes('invalid session identifier') ||
    SESSION_NOT_FOUND.test(value)
  )
}

function hasNotFoundHint(value: unknown, depth = 0): boolean {
  if (depth > 4) return false
  if (isNotFoundText(value)) return true
  if (Array.isArray(value)) return value.some((v) => hasNotFoundHint(v, depth + 1))
  if (value && typeof value === 'object')
    return Object.values(value).some((v) => hasNotFoundHint(v, depth + 1))
  return false
}

export function isSessionNotFound(err: unknown): boolean {
  if (err instanceof JsonRpcError) {
    return NOT_FOUND_CODES.has(err.code) || isNotFoundText(err.message) || hasNotFoundHint(err.data)
  }
  if (err instanceof Error) return isNotFoundText(err.message)
  return isNotFoundText(err)
}
