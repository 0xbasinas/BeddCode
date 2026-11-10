/** Copy advertised metadata without exposing values that may contain credentials. */
export function safeAdvertised(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]'
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value
  if (typeof value === 'string') return '[redacted]'
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeAdvertised(item, depth + 1))
  if (typeof value !== 'object') return '[redacted]'
  const result: Record<string, unknown> = Object.create(null)
  for (const [key, item] of Object.entries(value).slice(0, 60)) {
    if (/token|secret|password|credential|api.?key|authorization/i.test(key))
      result[key] = '[redacted]'
    else result[key] = safeAdvertised(item, depth + 1)
  }
  return result
}
