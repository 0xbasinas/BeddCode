import {
  configPath,
  normalizeRelayUrl,
  readConfigFile,
  writeConfigFile,
  type ConfigFile,
} from '../config.ts'
import type { Io } from './io.ts'

type SettingKey = Exclude<keyof ConfigFile, 'warmPool'>

type Kind = 'number' | 'string' | 'boolean' | 'list'

/** What can be set, and what each setting does. */
export const SETTINGS: Record<SettingKey, { kind: Kind; help: string }> = {
  claudeBackend: { kind: 'string', help: 'Claude backend: sdk (default) or cli' },
  port: { kind: 'number', help: 'Port the host listens on (default 3773)' },
  host: {
    kind: 'string',
    help: 'Address to listen on (127.0.0.1 only this machine, 0.0.0.0 other machines)',
  },
  allowLan: {
    kind: 'boolean',
    help: 'Also accept machines on the local network, not just the tailnet',
  },
  requireToken: { kind: 'boolean', help: "Ask for a paired device's token even from this machine" },
  allowedOrigins: { kind: 'list', help: 'Web page origins allowed to connect (comma separated)' },
  telemetry: {
    kind: 'boolean',
    help: 'Upload anonymous speed measurements to your relay (see `beddcode metrics`)',
  },
  agentSupervisor: {
    kind: 'boolean',
    help: 'Keep agents (Claude, Codex, Grok, Pi, OpenCode, ACP) running through a host restart (experimental)',
  },
  relayPassword: { kind: 'string', help: 'The password your relay asks of hosts, if you set one' },
  relayUrl: {
    kind: 'string',
    help: 'A relay address (https://relay.example.com) so devices on any network can reach this host',
  },
  retentionDays: {
    kind: 'number',
    help: 'Days a session stays quiet before the host removes it (0 keeps everything; `beddcode gc` runs it now)',
  },
}

const KEYS = Object.keys(SETTINGS) as SettingKey[]

/** Accepts `allow-lan` as well as `allowLan`. */
export function settingKey(name: string): SettingKey {
  const camel = name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
  const key = KEYS.find((k) => k.toLowerCase() === camel.toLowerCase())
  if (!key) throw new Error(`Unknown setting "${name}". Settings: ${KEYS.join(', ')}`)
  return key
}

export function parseValue(key: SettingKey, raw: string): ConfigFile[keyof ConfigFile] {
  const { kind } = SETTINGS[key]
  if (kind === 'number') {
    const n = Number(raw)
    if (key === 'retentionDays') {
      if (!Number.isInteger(n) || n < 0 || n > 3650)
        throw new Error(`${key} needs a whole number of days (0 to 3650)`)
      return n
    }
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${key} needs a port number`)
    return n
  }
  if (kind === 'boolean') {
    if (/^(true|on|yes|1)$/i.test(raw)) return true
    if (/^(false|off|no|0)$/i.test(raw)) return false
    throw new Error(`${key} is on or off`)
  }
  if (kind === 'list') {
    return raw
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  }
  if (key === 'claudeBackend' && raw !== 'sdk' && raw !== 'cli')
    throw new Error('claudeBackend must be sdk or cli')
  if (!raw) throw new Error(`${key} needs a value`)
  return key === 'relayUrl' ? normalizeRelayUrl(raw) : raw
}

const show = (v: unknown) => (Array.isArray(v) ? v.join(',') : String(v))

/**
 * `beddcode config`: the host's own settings, kept in `<data dir>/config.json` so they do not have
 * to be repeated as flags. Flags and BEDDCODE_* variables still win. A running host reads them
 * when it starts: restart it (the app's Hosts settings, or `beddcode install-service`) to apply.
 *   config                  show the file's settings
 *   config get <setting>
 *   config set <setting> <value>
 *   config unset <setting>
 */
export function configCmd(args: string[], io: Io, file = configPath()): number {
  const [action = 'list', name, ...value] = args
  const config = readConfigFile(file)

  if (action === 'list' || action === 'ls') {
    for (const key of KEYS) {
      const v = config[key]
      io.out(
        `${key.padEnd(15)} ${v === undefined ? '(default)' : key === 'relayPassword' ? '(set)' : show(v)}  — ${SETTINGS[key].help}\n`,
      )
    }
    io.err(`File: ${file}\n`)
    return 0
  }
  if (action === 'get') {
    if (!name) throw new Error('Usage: beddcode config get <setting>')
    const v = config[settingKey(name)]
    if (v === undefined) return 1
    io.out(`${show(v)}\n`)
    return 0
  }
  if (action === 'set') {
    if (!name || value.length === 0) throw new Error('Usage: beddcode config set <setting> <value>')
    const key = settingKey(name)
    writeConfigFile({ ...config, [key]: parseValue(key, value.join(' ')) }, file)
    io.err(`${key} saved. Restart the host to apply it.\n`)
    return 0
  }
  if (action === 'unset') {
    if (!name) throw new Error('Usage: beddcode config unset <setting>')
    const key = settingKey(name)
    const { [key]: _removed, ...rest } = config
    writeConfigFile(rest, file)
    io.err(`${key} is back to its default.\n`)
    return 0
  }
  throw new Error(`Unknown: beddcode config ${action}. Try get, set or unset.`)
}
