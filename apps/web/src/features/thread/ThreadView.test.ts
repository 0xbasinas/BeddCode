import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

describe('ThreadView hooks', () => {
  it('calls no hooks after the early return for a missing session', () => {
    const source = readFileSync(new URL('./ThreadView.tsx', import.meta.url), 'utf8')
    const start = source.indexOf('export function ThreadView(')
    const end = source.indexOf('\nfunction ', start)
    const body = source.slice(start, end)
    const early = body.indexOf('if (!session) {')
    expect(early).toBeGreaterThan(0)
    expect(body.slice(early)).not.toMatch(/\b(useEffect|useState|useMemo|useCallback|useRef)\(/)
  })
})
