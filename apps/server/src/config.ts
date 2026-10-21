import { defaultGuard, type GuardOptions } from './auth/guard.ts'

export interface ServerConfig {
  port: number
  /** Address to listen on. Loopback unless the user opens the host to other machines. */
  host: string
  guard: GuardOptions
}

const truthy = (v: string | undefined) => v === '1' || v === 'true'

/** Flags win over environment variables, which win over the safe defaults. */
export function parseServeArgs(
  args: string[],
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const guard = defaultGuard()
  guard.allowLan = truthy(env.BEDDCODE_ALLOW_LAN)
  guard.requireToken = truthy(env.BEDDCODE_REQUIRE_TOKEN)
  guard.allowedOrigins = (env.BEDDCODE_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean)
  const config: ServerConfig = {
    port: Number(env.BEDDCODE_PORT ?? 3773),
    host: env.BEDDCODE_HOST ?? '127.0.0.1',
    guard,
  }

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
      default:
        throw new Error(`Unknown option: ${arg}`)
    }
  }

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error(`Invalid port: ${config.port}`)
  }
  return config
}

/** Does listening on this address make the host reachable from other machines? */
export const isLoopbackHost = (host: string) =>
  host === 'localhost' || host === '::1' || host.startsWith('127.')
