import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { AcpAgentStore, AcpRegistry, currentPlatform } from '@beddcode/provider-acp'
import { AgentCatalog } from './catalog.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-catalog-'))
  dirs.push(d)
  return d
}

const tar =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
let server: Server
let base = ''
let archive: Buffer
beforeAll(async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'beddcode-catalog-src-'))
  dirs.push(work)
  mkdirSync(path.join(work, 'src', 'bin'), { recursive: true })
  writeFileSync(path.join(work, 'src', 'bin', 'agent'), 'program')
  execFileSync(tar, ['-czf', path.join(work, 'a.tar.gz'), '-C', path.join(work, 'src'), 'bin'])
  archive = readFileSync(path.join(work, 'a.tar.gz'))
  server = createServer((req, res) => {
    if (req.url !== '/agent.tar.gz') return void res.writeHead(404).end()
    res.writeHead(200).end(archive)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

function setup() {
  const dir = tmp()
  const registry = {
    agents: [
      {
        id: 'npx-agent',
        name: 'Npx Agent',
        version: '1.0.0',
        description: 'runs via npx',
        distribution: { npx: { package: 'x@1' } },
      },
      {
        id: 'bin-agent',
        name: 'Binary Agent',
        version: '2.0.0',
        description: 'ships a program',
        distribution: {
          binary: {
            [currentPlatform()]: {
              archive: `${base}/agent.tar.gz`,
              cmd: './bin/agent',
              args: ['acp'],
              sha256: createHash('sha256').update(archive).digest('hex'),
            },
          },
        },
      },
      {
        id: 'other-os',
        name: 'Other OS Only',
        version: '1.0.0',
        description: '',
        distribution: { binary: { 'plan9-mips': { archive: 'https://x/a', cmd: './a' } } },
      },
    ],
  }
  let changes = 0
  const store = new AcpAgentStore(path.join(dir, 'acp.json'))
  const catalog = new AgentCatalog(
    store,
    new AcpRegistry({ fetch: async () => Response.json(registry) }),
    () => changes++,
    { root: path.join(dir, 'agents'), allowLocalHttp: true },
  )
  return { dir, store, catalog, changes: () => changes }
}

describe('AgentCatalog downloads', () => {
  it('tells the app which entries download a program, and which cannot run here', async () => {
    const { catalog } = setup()
    const entries = Object.fromEntries(
      (await catalog.searchRegistry(undefined)).map((e) => [e.id, e]),
    )
    expect(entries['npx-agent']).toMatchObject({ installable: true, download: undefined })
    expect(entries['bin-agent']).toMatchObject({
      installable: true,
      download: { host: expect.stringContaining('127.0.0.1'), verified: true },
    })
    expect(entries['other-os']).toMatchObject({
      installable: false,
      reason: expect.stringContaining('No build'),
    })
  })

  it('does not download until the user agrees', async () => {
    const { catalog, dir } = setup()
    await expect(catalog.add({ registryId: 'bin-agent' })).rejects.toThrow('Confirm to continue')
    expect(existsSync(path.join(dir, 'agents'))).toBe(false)
    await expect(catalog.add({ registryId: 'other-os', acceptDownload: true })).rejects.toThrow(
      'No build',
    )
  })

  it('downloads on agreement, registers the program, and deletes it with the agent', async () => {
    const { catalog, dir, store, changes } = setup()
    const added = await catalog.add({ registryId: 'bin-agent', acceptDownload: true })
    expect(added).toMatchObject({ id: 'bin-agent', registryId: 'bin-agent', args: ['acp'] })
    expect(path.isAbsolute(added.command)).toBe(true)
    expect(readFileSync(added.command, 'utf8')).toBe('program')
    expect(store.get('bin-agent')?.command).toBe(added.command)
    expect(changes()).toBe(1)

    expect(await catalog.remove('bin-agent')).toEqual({ removed: true })
    expect(existsSync(path.join(dir, 'agents', 'bin-agent'))).toBe(false)
    expect(changes()).toBe(2)
  })

  it('still adds package-tool agents without any download step', async () => {
    const { catalog } = setup()
    expect(await catalog.add({ registryId: 'npx-agent' })).toMatchObject({ command: 'npx' })
  })
})
