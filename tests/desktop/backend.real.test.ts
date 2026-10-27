import type { ElectronApplication } from 'playwright-core'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { Host } from '../shared/hostClient.ts'
import { agentBackend, type Backend } from './deepseek.ts'
import { desktopEnv, launchDesktop, type DesktopEnv } from './launch.ts'
import { rmSync } from 'node:fs'

// Checks the agent backend the heavy tests use: each CLI answers one short prompt.
const providers = [
  { name: 'claude', id: 'claude', mode: 'default' },
  { name: 'codex', id: 'codex', mode: 'read-only' },
  { name: 'grok', id: 'acp:grok', mode: 'ask' },
].filter((p) => (process.env.DESKTOP_PROVIDERS ?? 'claude,codex,grok').split(',').includes(p.name))

let env: DesktopEnv
let app: ElectronApplication
let host: Host
let backend: Backend

beforeAll(async () => {
  backend = agentBackend()
  env = await desktopEnv(true)
  const launched = await launchDesktop(env, true, backend.env)
  app = launched.app
  await launched.page
    .getByRole('heading', { name: 'Welcome to BeddCode' })
    .waitFor({ timeout: 90_000 })
  host = new Host(`ws://127.0.0.1:${env.port}/ws`)
  await host.connect()
})

afterAll(async () => {
  host?.close()
  await app?.close().catch(() => {})
  backend?.cleanup()
  for (const folder of [env?.home, env?.userData]) {
    if (folder) rmSync(folder, { recursive: true, force: true })
  }
})

describe.each(providers)('$name backend', (provider) => {
  test('answers a short prompt', async () => {
    const created = await host.rpc('sessions.create', {
      instanceId: provider.id,
      projectless: true,
      permissionMode: provider.mode,
      title: `Backend ${provider.name}`,
    })
    const from = host.events.length
    await host.rpc('sessions.prompt', {
      sessionId: created.sessionId,
      text: 'Without using tools, reply with only the single word PONG.',
    })
    await host.wait(
      () =>
        host.events
          .slice(from)
          .some(
            ({ event }) => event.sessionId === created.sessionId && event.type === 'turn.completed',
          ),
      90_000,
    )
    const events = host.events.slice(from).map(({ event }) => event)
    const end = events.find((e) => e.type === 'turn.completed')
    const text = events
      .filter((e) => e.type === 'message.delta' && e.role === 'assistant')
      .map((e) => e.text)
      .join('')
    const models = events
      .filter((e) => e.type === 'session.usage' && e.model)
      .map((e) => e.model as string)
    console.log(provider.name, backend.name, end?.reason, JSON.stringify(text.slice(0, 80)), models)
    expect(end?.reason).toBe('done')
    expect(text).toContain('PONG')
    if (backend.name === 'deepseek' && models.length) {
      expect(models.join(' ')).toMatch(/deepseek/i)
    }
  })
})
