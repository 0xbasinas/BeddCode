import { describe, expect, it, vi } from 'vitest'
import { createCodexFingerprint } from './fingerprint.ts'

describe('Codex warm fingerprint', () => {
  it('tracks binary, config, auth and environment without retaining their values', () => {
    const files = new Map<string, { content: string; time: number }>([
      ['/bin/codex', { content: 'binary', time: 1 }],
      ['/home/test/.codex/config.toml', { content: 'config secret', time: 1 }],
      ['/home/test/.codex/auth.json', { content: 'auth secret', time: 1 }],
    ])
    // path.join yields backslashes on Windows; the fixtures are keyed with forward slashes.
    const key = (file: string) => file.replaceAll('\\', '/')
    const fs = {
      stat: (file: string) => {
        const item = files.get(key(file))
        if (!item) throw Object.assign(new Error('missing'), { code: 'ENOENT' })
        return { dev: 1, ino: 1, size: item.content.length, mtimeMs: item.time, ctimeMs: item.time }
      },
      read: vi.fn((file: string) => Buffer.from(files.get(key(file))!.content)),
      realpath: (file: string) => file,
    }
    const env: NodeJS.ProcessEnv = { HOME: '/home/test', OPENAI_API_KEY: 'secret' }
    const fingerprint = createCodexFingerprint(
      () => '/bin/codex',
      () => env,
      fs,
    )
    let previous = fingerprint()
    expect(previous).not.toContain('secret')
    expect(fingerprint()).toBe(previous)
    expect(fs.read).toHaveBeenCalledTimes(2)
    for (const file of [
      '/bin/codex',
      '/home/test/.codex/config.toml',
      '/home/test/.codex/auth.json',
    ]) {
      files.get(file)!.time++
      if (!file.startsWith('/bin')) files.get(file)!.content += '!'
      const next = fingerprint()
      expect(next).not.toBe(previous)
      previous = next
    }
    env.OPENAI_API_KEY = 'another secret'
    expect(fingerprint()).not.toBe(previous)
    previous = fingerprint()
    files.delete('/home/test/.codex/auth.json')
    expect(fingerprint()).not.toBe(previous)
  })
})
