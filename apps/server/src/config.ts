import { readJsonFile, writeFileAtomic } from '@beddcode/shared'
import path from 'node:path'
import { defaultGuard, type GuardOptions } from './auth/guard.ts'
import { dataHome } from './hostIdentity.ts'

export interface ServerConfig {
  port: number
  /** Address to listen on. Loopback unless the user opens the host to other machines. */
  host: string
  guard: GuardOptions
  /** A relay that lets devices on any network reach this host (e.g. wss://relay.example.com). */
  relayUrl?: string
  /** The password the relay asks of hosts, when its owner set one. */
  relayPassword?: string
  /** Upload anonymous speed measurements to the relay. */
  telemetry?: boolean
}

/** Settings kept in `<data dir>/config.json` (see `beddcode config`); flags and variables win. */
export interface ConfigFile {
  port?: number
  host?: string
  allowLan?: boolean
  requireToken?: boolean
  allowedOrigins?: string[]
  relayUrl?: string
  relayPassword?: string
  telemetry?: boolean
}

export const configPath = () => path.join(dataHome(), 'config.json')

export function readConfigFile(file = configPath()): ConfigFile {
  // A damaged file is moved aside (not overwritten by the next save), and defaults apply.
  const read = readJsonFile(file)
  if (read.status === 'corrupt') {
    console.warn(
      `${file} is damaged (${read.error}); using the default settings.` +
        (read.quarantined ? ` The old file was kept as ${read.quarantined}.` : ''),
    )
  }
  if (read.status !== 'ok') return {}
  const parsed = read.value
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as ConfigFile)
    : {}
}

export function writeConfigFile(config: ConfigFile, file = configPath()): void {
  // May hold the relay password, so only this user reads it.
  writeFileAtomic(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 })
}

/**
 * A relay can be given as an ordinary address (`relay.example.com`, `https://relay.example.com`);
 * the websocket form is derived from it. Plain http/ws is only for a relay on this machine or network.
 */
export function normalizeRelayUrl(input: string): string {
  const raw = input.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    throw new Error(`The relay address must look like https://relay.example.com, not ${input}`)
  }
  const scheme: Record<string, string> = {
    'https:': 'wss:',
    'wss:': 'wss:',
    'http:': 'ws:',
    'ws:': 'ws:',
  }
  const proto = scheme[url.protocol]
  if (!proto || !url.hostname || url.username || url.search || url.hash || url.pathname !== '/') {
    throw new Error(`The relay address must look like https://relay.example.com, not ${input}`)
  }
  return `${proto}//${url.host}`
}

const truthy = (v: string | undefined) => v === '1' || v === 'true'

/**
 * The settings the host runs with. Built-in defaults, then the config file, then environment
 * variables, then flags: the closer to the command, the stronger. The file is only read for the
 * real environment, so tests and embedders get exactly what they pass.
 */
export function parseServeArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
  file: ConfigFile = env === process.env ? readConfigFile() : {},
): ServerConfig {
  const guard = defaultGuard()
  guard.allowLan =
    env.BEDDCODE_ALLOW_LAN !== undefined ? truthy(env.BEDDCODE_ALLOW_LAN) : !!file.allowLan
  guard.requireToken =
    env.BEDDCODE_REQUIRE_TOKEN !== undefined
      ? truthy(env.BEDDCODE_REQUIRE_TOKEN)
      : !!file.requireToken
  guard.allowedOrigins =
    env.BEDDCODE_ALLOWED_ORIGINS !== undefined
      ? env.BEDDCODE_ALLOWED_ORIGINS.split(',')
          .map((o) => o.trim())
          .filter(Boolean)
      : [...(file.allowedOrigins ?? [])]
  const config: ServerConfig = {
    port: Number(env.BEDDCODE_PORT ?? file.port ?? 3773),
    host: env.BEDDCODE_HOST ?? file.host ?? '127.0.0.1',
    guard,
  }
  const relayUrl = env.BEDDCODE_RELAY_URL ?? file.relayUrl
  if (relayUrl) config.relayUrl = relayUrl
  const relayPassword = env.BEDDCODE_RELAY_PASSWORD ?? file.relayPassword
  if (relayPassword) config.relayPassword = relayPassword
  const telemetry =
    env.BEDDCODE_TELEMETRY !== undefined ? truthy(env.BEDDCODE_TELEMETRY) : file.telemetry
  if (telemetry !== undefined) config.telemetry = telemetry

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const value = () => {
      const next = args[++i]
      if (next === undefined) throw new Error(`${arg} needs a value`)
      return next
    }
    switch (arg) {
      case '--port':
        config.port = Number(value())
        break
      case '--host':
        config.host = value()
        break
      case '--allow-lan':
        guard.allowLan = true
        break
      case '--require-token':
        guard.requireToken = true
        break
      case '--allow-origin':
        guard.allowedOrigins.push(value())
        break
      case '--relay-url':
        config.relayUrl = value()
        break
      case '--relay-password':
        config.relayPassword = value()
        break
      case '--telemetry':
        config.telemetry = true
        break
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`)
  }
  if (config.relayUrl) config.relayUrl = normalizeRelayUrl(config.relayUrl)
  return config
}

/** Does listening on this address make the host reachable from other machines? */
export const isLoopbackHost = (host: string) =>
  host === 'localhost' || host === '::1' || host.startsWith('127.')
