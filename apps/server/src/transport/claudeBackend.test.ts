import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createRpcRouter } from './rpc.ts'

const dir = mkdtempSync(path.join(os.tmpdir(), 'claude-backend-'))
afterEach(() => { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

it('validates and persists the host backend without losing other settings', async () => {
  vi.stubEnv('BEDDCODE_HOME', dir)
  writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port: 4321 }))
  const dispatch = createRpcRouter({} as never, {} as never, {} as never, {} as never, {} as never, {} as never)
  const context = { peer: 'loopback' } as const
  expect(await dispatch('host.claudeBackend.get', {}, context)).toEqual({ claudeBackend: 'sdk' })
  expect(await dispatch('host.claudeBackend.set', { claudeBackend: 'cli' }, context)).toEqual({ claudeBackend: 'cli' })
  expect(await dispatch('host.claudeBackend.get', {}, context)).toEqual({ claudeBackend: 'cli' })
  expect(JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'))).toEqual({ port: 4321, claudeBackend: 'cli' })
  await expect(dispatch('host.claudeBackend.set', { claudeBackend: 'invalid' }, context)).rejects.toThrow()
})
