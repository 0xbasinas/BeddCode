import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { McpGatewaySettings } from '@beddcode/contracts'
import { GatewayHost, type GatewayHostOptions } from './host.ts'

interface Saved {
  url?: string
  secret?: string
  allowApprovals?: boolean
  allowProjectRead?: boolean
}

export class GatewayControl {
  private readonly file: string
  private saved: Saved
  private host?: GatewayHost

  constructor(
    private readonly options: Omit<GatewayHostOptions, 'url' | 'secret' | 'projects'>,
    private readonly projects: () => Promise<string[]>,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    this.file = path.join(options.home, 'mcp-gateway.json')
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'))
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
        throw new Error('Invalid settings')
      const value = parsed as Record<string, unknown>
      this.saved = {
        url: typeof value.url === 'string' ? value.url : undefined,
        secret: typeof value.secret === 'string' ? value.secret : undefined,
        allowApprovals: typeof value.allowApprovals === 'boolean' ? value.allowApprovals : true,
        allowProjectRead:
          typeof value.allowProjectRead === 'boolean' ? value.allowProjectRead : true,
      }
    } catch {
      this.saved = {
        url: env.BEDDCODE_MCP_GATEWAY_URL,
        secret: env.BEDDCODE_MCP_HOST_SECRET,
      }
    }
    if (this.saved.url && this.saved.secret) {
      try {
        this.host = new GatewayHost({
          ...options,
          url: this.saved.url,
          secret: this.saved.secret,
          projects: this.projects,
          allowApprovals: () => this.saved.allowApprovals !== false,
          allowProjectRead: () => this.saved.allowProjectRead !== false,
        })
        this.host.start()
      } catch {
        options.log.warn('MCP gateway settings are invalid')
      }
    }
  }

  get(): McpGatewaySettings {
    return {
      url: this.saved.url,
      secretSet: !!this.saved.secret,
      status: this.host?.status ?? 'off',
      allowApprovals: this.saved.allowApprovals !== false,
      allowProjectRead: this.saved.allowProjectRead !== false,
      ...(this.host?.error ? { error: this.host.error } : {}),
    }
  }

  async set(
    input: string | null,
    secret?: string,
    allowApprovals?: boolean,
    allowProjectRead?: boolean,
  ): Promise<McpGatewaySettings> {
    if (!input) {
      this.persist({
        allowApprovals: allowApprovals ?? this.saved.allowApprovals,
        allowProjectRead: allowProjectRead ?? this.saved.allowProjectRead,
      })
      this.host?.stop()
      this.host = undefined
      return this.get()
    }
    let url: URL
    try {
      url = new URL(input.trim())
    } catch {
      throw new Error('Enter a valid HTTPS or WSS gateway URL')
    }
    if (url.protocol === 'https:') url.protocol = 'wss:'
    if (
      url.protocol !== 'wss:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !['/', '/host', '/mcp'].includes(url.pathname)
    )
      throw new Error('Enter the HTTPS address of your MCP gateway')
    url.pathname = '/host'
    const nextSecret = secret?.trim() || this.saved.secret
    if (!nextSecret) throw new Error('Enter the host secret configured on the Worker')
    const next = {
      url: url.toString(),
      secret: nextSecret,
      allowApprovals: allowApprovals ?? this.saved.allowApprovals ?? true,
      allowProjectRead: allowProjectRead ?? this.saved.allowProjectRead ?? true,
    }
    if (
      this.host &&
      (allowApprovals !== undefined || allowProjectRead !== undefined) &&
      next.url === this.saved.url &&
      next.secret === this.saved.secret
    ) {
      this.persist(next)
      return this.get()
    }
    const host = new GatewayHost({
      ...this.options,
      url: next.url,
      secret: next.secret,
      projects: this.projects,
      allowApprovals: () => this.saved.allowApprovals !== false,
      allowProjectRead: () => this.saved.allowProjectRead !== false,
    })
    this.persist(next)
    this.host?.stop()
    this.saved = next
    this.host = host
    host.start()
    return this.get()
  }

  stop() {
    this.host?.stop()
  }

  private persist(saved: Saved) {
    mkdirSync(this.options.home, { recursive: true })
    writeFileSync(this.file, JSON.stringify(saved), { mode: 0o600 })
    this.saved = saved
  }
}
