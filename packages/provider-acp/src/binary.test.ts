import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { binaryFor, currentPlatform, installBinary, planInstall, removeInstall } from './binary.ts'
import type { RegistryAgent } from './registry.ts'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))
const tmp = () => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'beddcode-bin-'))
  dirs.push(d)
  return d
}

const tar =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar'
const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex')

/** A tiny file server standing in for GitHub releases. */
let server: Server
let base = ''
const files = new Map<string, Buffer>()
const hits: string[] = []
beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req.url ?? '')
    const body = files.get(req.url ?? '')
    if (!body) return void res.writeHead(404).end()
    res.writeHead(200, { 'content-length': body.length }).end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterAll(() => new Promise<void>((r) => server.close(() => r())))

/** Builds an archive with `tar` itself, so the test unpacks what a real release would contain. */
function makeArchive(name: string, entries: Record<string, string>, flags: string[]) {
  const work = tmp()
  const src = path.join(work, 'src')
  for (const [rel, text] of Object.entries(entries)) {
    mkdirSync(path.dirname(path.join(src, rel)), { recursive: true })
    writeFileSync(path.join(src, rel), text)
  }
  const out = path.join(work, name)
  execFileSync(tar, [
    ...flags,
    out,
    '-C',
    src,
    ...Object.keys(entries)
      .map((e) => e.split('/')[0]!)
      .filter((v, i, a) => a.indexOf(v) === i),
  ])
  return readFileSync(out)
}

const agentFor = (
  target: Record<string, unknown>,
  extra: Partial<RegistryAgent> = {},
): RegistryAgent => ({
  id: 'demo',
  name: 'Demo',
  version: '1.2.3',
  description: '',
  distribution: { binary: { [currentPlatform()]: target } },
  ...extra,
})

describe('platform and plan', () => {
  it("maps this machine to the registry's platform keys", () => {
    expect(currentPlatform('win32', 'x64')).toBe('windows-x86_64')
    expect(currentPlatform('linux', 'arm64')).toBe('linux-aarch64')
    expect(currentPlatform('darwin', 'arm64')).toBe('darwin-aarch64')
    expect(currentPlatform('linux', 'x64')).toBe('linux-x86_64')
  })

  it('plans a run, a download, or nothing', () => {
    const run = { command: 'npx', args: [], env: {} }
    expect(planInstall(agentFor({}), run)).toEqual({ type: 'run', launch: run })

    const download = planInstall(
      agentFor({ archive: 'https://github.com/o/r/releases/a.zip', cmd: './a', sha256: 'abc' }),
      undefined,
    )
    expect(download).toMatchObject({ type: 'download', host: 'github.com', verified: true })
    expect(
      planInstall(
        agentFor({ archive: 'https://github.com/o/r/releases/a.zip', cmd: './a' }),
        undefined,
      ),
    ).toMatchObject({ type: 'download', verified: false })

    expect(
      planInstall(agentFor({ archive: 'x', cmd: 'y' }), undefined, 'linux-riscv'),
    ).toMatchObject({
      type: 'unavailable',
      reason: expect.stringContaining('No build for this machine'),
    })
    expect(planInstall(agentFor({ archive: 'not a url', cmd: 'y' }), undefined)).toMatchObject({
      type: 'unavailable',
    })
    expect(planInstall({ ...agentFor({}), distribution: {} }, undefined)).toMatchObject({
      type: 'unavailable',
    })
    expect(binaryFor(agentFor({ nonsense: true }))).toBeUndefined()
  })
})

describe('installBinary', () => {
  const options = (root: string) => ({ root, allowLocalHttp: true })

  it('downloads, verifies, unpacks and marks the program runnable', async () => {
    const archive = makeArchive('a.tar.gz', { 'demo-agent/run.txt': '#!/bin/sh\necho hi\n' }, [
      '-czf',
    ])
    files.set('/a.tar.gz', archive)
    const root = tmp()
    const agent = agentFor({
      archive: `${base}/a.tar.gz`,
      cmd: './demo-agent/run.txt',
      args: ['--acp'],
      env: { A: 'b' },
      sha256: sha(archive),
    })

    const launch = await installBinary(agent, options(root))
    expect(launch).toEqual({
      command: path.join(root, 'demo', '1.2.3', 'demo-agent', 'run.txt'),
      args: ['--acp'],
      env: { A: 'b' },
    })
    expect(readFileSync(launch.command, 'utf8')).toContain('echo hi')
    // The downloaded archive is not left behind.
    expect(existsSync(path.join(root, 'demo', '1.2.3', '.download-a.tar.gz'))).toBe(false)

    // Installed already: nothing is fetched again.
    const before = hits.length
    await installBinary(agent, options(root))
    expect(hits.length).toBe(before)
  })

  it('discards a download that does not match its checksum', async () => {
    const archive = makeArchive('b.tar.gz', { 'x/run.txt': 'x' }, ['-czf'])
    files.set('/b.tar.gz', archive)
    const root = tmp()
    await expect(
      installBinary(
        agentFor({ archive: `${base}/b.tar.gz`, cmd: './x/run.txt', sha256: '0'.repeat(64) }),
        options(root),
      ),
    ).rejects.toThrow('checksum')
    expect(existsSync(path.join(root, 'demo'))).toBe(true) // the agent folder, but...
    expect(existsSync(path.join(root, 'demo', '1.2.3'))).toBe(false)
  })

  it('installs without a checksum when the registry publishes none', async () => {
    const archive = makeArchive('c.tar.gz', { 'x/run.txt': 'x' }, ['-czf'])
    files.set('/c.tar.gz', archive)
    const launch = await installBinary(
      agentFor({ archive: `${base}/c.tar.gz`, cmd: './x/run.txt' }),
      options(tmp()),
    )
    expect(existsSync(launch.command)).toBe(true)
  })

  it('unpacks zip archives', async () => {
    let archive: Buffer
    try {
      archive = makeArchive(
        'd.zip',
        { 'x/run.txt': 'zipped' },
        process.platform === 'win32' ? ['-a', '-cf'] : ['-a', '-cf'],
      )
    } catch {
      return // this machine's tar cannot write zip; the extraction path is covered on Windows
    }
    // GNU tar accepts `-a -cf d.zip` and writes a tar stream; only a real zip can test unzip.
    if (archive.subarray(0, 2).toString() !== 'PK') return
    files.set('/d.zip', archive)
    if (process.platform !== 'win32') {
      try {
        execFileSync('unzip', ['-v'], { stdio: 'ignore' })
      } catch {
        return
      }
    }
    const launch = await installBinary(
      agentFor({ archive: `${base}/d.zip`, cmd: './x/run.txt', sha256: sha(archive) }),
      options(tmp()),
    )
    expect(readFileSync(launch.command, 'utf8')).toBe('zipped')
  })

  it('keeps a bare executable under its own name', async () => {
    const body = Buffer.from('MZ-binary')
    files.set('/agent-win.exe', body)
    const root = tmp()
    const launch = await installBinary(
      agentFor({ archive: `${base}/agent-win.exe`, cmd: './agent-win.exe', sha256: sha(body) }),
      options(root),
    )
    expect(readFileSync(launch.command)).toEqual(body)
  })

  it('refuses insecure addresses, missing programs, oversized and unreachable downloads', async () => {
    const root = tmp()
    await expect(
      installBinary(agentFor({ archive: 'http://example.com/a.zip', cmd: './a' }), { root }),
    ).rejects.toThrow('https')
    await expect(
      installBinary(agentFor({ archive: `${base}/a.zip`, cmd: './a' }), { root }),
    ).rejects.toThrow('https')

    const archive = makeArchive('e.tar.gz', { 'x/run.txt': 'x' }, ['-czf'])
    files.set('/e.tar.gz', archive)
    await expect(
      installBinary(agentFor({ archive: `${base}/e.tar.gz`, cmd: './missing' }), options(root)),
    ).rejects.toThrow('did not contain')
    expect(existsSync(path.join(root, 'demo', '1.2.3'))).toBe(false)

    await expect(
      installBinary(agentFor({ archive: `${base}/e.tar.gz`, cmd: './x/run.txt' }), {
        ...options(root),
        maxBytes: 10,
      }),
    ).rejects.toThrow('larger than expected')
    await expect(
      installBinary(agentFor({ archive: `${base}/nope.tar.gz`, cmd: './x' }), options(root)),
    ).rejects.toThrow('404')
    expect(existsSync(path.join(root, 'demo', '1.2.3'))).toBe(false)
  })

  it('refuses a launch command that points outside the install folder', async () => {
    await expect(
      installBinary(agentFor({ archive: `${base}/a.tar.gz`, cmd: '../../evil' }), options(tmp())),
    ).rejects.toThrow('outside')
  })

  it.skipIf(process.platform === 'win32')(
    'refuses archives containing links that lead elsewhere',
    async () => {
      const work = tmp()
      const src = path.join(work, 'src')
      mkdirSync(src, { recursive: true })
      writeFileSync(path.join(src, 'run.txt'), 'x')
      symlinkSync('/etc', path.join(src, 'escape'))
      const out = path.join(work, 'f.tar.gz')
      execFileSync(tar, ['-czf', out, '-C', src, 'run.txt', 'escape'])
      files.set('/f.tar.gz', readFileSync(out))
      const root = tmp()
      await expect(
        installBinary(agentFor({ archive: `${base}/f.tar.gz`, cmd: './run.txt' }), options(root)),
      ).rejects.toThrow('outside')
      expect(existsSync(path.join(root, 'demo', '1.2.3'))).toBe(false)
    },
  )

  it('removes an installed agent and ignores unknown ones', async () => {
    const root = tmp()
    const archive = makeArchive('g.tar.gz', { 'x/run.txt': 'x' }, ['-czf'])
    files.set('/g.tar.gz', archive)
    await installBinary(
      agentFor({ archive: `${base}/g.tar.gz`, cmd: './x/run.txt' }),
      options(root),
    )
    expect(await removeInstall(root, 'demo')).toBe(true)
    expect(existsSync(path.join(root, 'demo'))).toBe(false)
    expect(await removeInstall(root, 'demo')).toBe(false)
    expect(await removeInstall(root, '../../etc')).toBe(false)
  })
})
