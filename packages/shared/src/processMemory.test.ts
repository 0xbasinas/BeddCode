import { describe, expect, it } from 'vitest'
import {
  ESTIMATED_PROCESS_BYTES,
  measureProcessMemory,
  readProcessMemory,
  type ProcessMemoryDeps,
} from './processMemory.ts'

const ok = (stdout: string) => async () => ({ code: 0, stdout, stderr: '' })

describe('readProcessMemory', () => {
  const files: Record<string, string> = {
    '/proc/10/status': 'Name:\tcodex\nVmRSS:\t   2048 kB\n',
    '/proc/11/status': 'VmRSS:\t1000 kB\n',
    '/proc/12/status': 'VmRSS:\t500 kB\n',
    '/proc/10/task/10/children': '11 ',
    '/proc/11/task/11/children': '12',
    '/proc/12/task/12/children': '',
  }
  const linux: ProcessMemoryDeps = {
    platform: 'linux',
    readFile: async (path) => {
      if (path in files) return files[path]!
      throw new Error('ENOENT')
    },
    readdir: async (path) => {
      const task = /\/proc\/(\d+)\/task/.exec(path)![1]!
      return [task]
    },
  }

  it('reads VmRSS of the process and its descendants from /proc', async () => {
    expect(await readProcessMemory(10, linux)).toBe((2048 + 1000 + 500) * 1024)
  })
  it('measures the process alone when children cannot be listed', async () => {
    expect(
      await readProcessMemory(10, {
        ...linux,
        readdir: async () => Promise.reject(new Error('x')),
      }),
    ).toBe(2048 * 1024)
  })
  it('returns null when the process is gone or has no VmRSS', async () => {
    expect(await readProcessMemory(99, linux)).toBeNull()
    expect(await readProcessMemory(12, { ...linux, readFile: async () => 'Name: x\n' })).toBeNull()
  })

  it('parses tasklist output on Windows', async () => {
    let args: string[] = []
    const deps: ProcessMemoryDeps = {
      platform: 'win32',
      run: async (_file, a) => {
        args = a
        return { code: 0, stdout: '"codex.exe","42","Console","1","123,456 K"\r\n', stderr: '' }
      },
    }
    expect(await readProcessMemory(42, deps)).toBe(123_456 * 1024)
    expect(args).toEqual(['/FI', 'PID eq 42', '/FO', 'CSV', '/NH'])
    const none = {
      platform: 'win32',
      run: ok('INFO: No tasks are running which match the specified criteria.\r\n'),
    } as const
    expect(await readProcessMemory(42, none)).toBeNull()
  })

  it('parses ps output on macOS', async () => {
    expect(await readProcessMemory(7, { platform: 'darwin', run: ok('  4096\n') })).toBe(
      4096 * 1024,
    )
    expect(await readProcessMemory(7, { platform: 'darwin', run: ok('') })).toBeNull()
    expect(await readProcessMemory(7, { platform: 'darwin', run: ok('garbage') })).toBeNull()
  })

  it('returns null on command failure, throw, or a bad pid', async () => {
    const failed = async () => ({ code: 1, stdout: '', stderr: 'no' })
    expect(await readProcessMemory(7, { platform: 'darwin', run: failed })).toBeNull()
    expect(
      await readProcessMemory(7, {
        platform: 'win32',
        run: async () => Promise.reject(new Error('timeout')),
      }),
    ).toBeNull()
    expect(await readProcessMemory(undefined, linux)).toBeNull()
    expect(await readProcessMemory(-1, linux)).toBeNull()
  })

  it('falls back to the estimate when measuring fails', async () => {
    expect(await measureProcessMemory(7, { platform: 'darwin', run: ok('') })).toBe(
      ESTIMATED_PROCESS_BYTES,
    )
    expect(await measureProcessMemory(7, { platform: 'darwin', run: ok('10') })).toBe(10 * 1024)
  })
})
