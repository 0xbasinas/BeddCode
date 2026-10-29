import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GatewayHostOptions } from './host.ts'
import { GatewayControl } from './control.ts'

vi.mock('./host.ts', () => ({
  GatewayHost: class {
    status = 'off'
    start() {
      this.status = 'connecting'
    }
    stop() {
      this.status = 'off'
    }
  },
}))

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function make(env: NodeJS.ProcessEnv = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'beddcode-mcp-control-'))
  dirs.push(home)
  const project = path.join(home, 'project')
  const options = { home, sessions: {}, store: {}, log: { warn: vi.fn() } } as unknown as Omit<
    GatewayHostOptions,
    'url' | 'secret' | 'projects'
  >
  return {
    home,
    project,
    options,
    control: new GatewayControl(options, async () => [project], env),
  }
}

describe('remote MCP settings', () => {
  it('saves, reconnects and disconnects without returning the secret', async () => {
    const { home, project, options, control } = make()
    const view = await control.set('https://example.workers.dev/mcp', 'private')
    expect(view).toEqual({
      url: 'wss://example.workers.dev/host',
      secretSet: true,
      status: 'connecting',
      allowApprovals: true,
      allowProjectRead: true,
    })
    expect(JSON.stringify(view)).not.toContain('private')
    expect(readFileSync(path.join(home, 'mcp-gateway.json'), 'utf8')).toContain('private')
    const restarted = new GatewayControl(options, async () => [project], {})
    expect(restarted.get().status).toBe('connecting')
    await restarted.set(null)
    expect(restarted.get()).toEqual({
      url: undefined,
      secretSet: false,
      status: 'off',
      allowApprovals: true,
      allowProjectRead: true,
    })
    expect(
      new GatewayControl(options, async () => [project], {
        BEDDCODE_MCP_GATEWAY_URL: 'wss://example/host',
        BEDDCODE_MCP_PROJECT: project,
        BEDDCODE_MCP_HOST_SECRET: 'old',
      }).get().status,
    ).toBe('off')
  })

  it('rejects insecure URLs and requires a secret', async () => {
    const { control } = make()
    await expect(control.set('http://example.com', 'secret')).rejects.toThrow('HTTPS')
    await expect(control.set('https://example.com')).rejects.toThrow('secret')
    expect(control.get().status).toBe('off')
  })

  it('persists access controls without replacing the connection', async () => {
    const { control, options, project } = make()
    await control.set('https://example.com', 'secret')
    const updated = await control.set('https://example.com', undefined, false, false)
    expect(updated).toMatchObject({
      allowApprovals: false,
      allowProjectRead: false,
      status: 'connecting',
    })
    expect(new GatewayControl(options, async () => [project], {}).get()).toMatchObject({
      allowApprovals: false,
      allowProjectRead: false,
    })
  })
})
