import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { extendUserPath } from './userPath.ts'

const join = (...dirs: string[]) => dirs.join(path.delimiter)

describe('extendUserPath', () => {
  const home = '/home/dev'
  const existing = new Set([
    '/home/dev/.local/bin',
    '/home/dev/.nvm/versions/node/v22.23.4/bin',
    '/home/dev/.grok/bin',
  ])

  it('keeps the current PATH first, then the login shell, then per-user folders that exist', () => {
    const out = extendUserPath(join('/usr/bin', '/bin'), {
      home,
      loginShellPath: () => join('/home/dev/.maestro/bin', '/usr/bin'),
      isDir: (p) => existing.has(p.replaceAll('\\', '/')),
      nvmBins: () => ['/home/dev/.nvm/versions/node/v22.23.4/bin'],
    }).replaceAll('\\', '/')
    expect(out.split(path.delimiter)).toEqual([
      '/usr/bin',
      '/bin',
      '/home/dev/.maestro/bin',
      '/home/dev/.local/bin',
      '/home/dev/.nvm/versions/node/v22.23.4/bin',
      '/home/dev/.grok/bin',
    ])
  })

  it('works when the login shell gives nothing', () => {
    const out = extendUserPath(undefined, {
      home,
      loginShellPath: () => undefined,
      isDir: () => false,
      nvmBins: () => [],
    })
    expect(out).toBe('')
  })
})
