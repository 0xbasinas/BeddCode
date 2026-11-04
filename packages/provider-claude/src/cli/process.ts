import { randomUUID } from 'node:crypto'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { trackChild } from '@beddcode/shared'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export interface CliOptions {
  cwd: string
  executablePath?: string
  env?: NodeJS.ProcessEnv
  model?: string
  effort?: string
  resumeId?: string
  sessionId?: string
  permissionMode?: string
  mcpConfig?: string
  permissionPromptTool?: string
  additionalDirectories?: string[]
}

export function buildCliArgs(options: CliOptions): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
  ]
  if (options.model) args.push('--model', options.model)
  if (options.effort) args.push('--effort', options.effort)
  if (options.resumeId) args.push('--resume', options.resumeId)
  else if (options.sessionId) args.push('--session-id', options.sessionId)
  if (options.permissionMode)
    args.push(
      '--permission-mode',
      options.permissionMode === 'default' ? 'manual' : options.permissionMode,
    )
  if (options.mcpConfig) args.push('--mcp-config', options.mcpConfig)
  if (options.permissionPromptTool)
    args.push('--permission-prompt-tool', options.permissionPromptTool)
  for (const dir of options.additionalDirectories ?? []) args.push('--add-dir', dir)
  return args
}

export class ClaudeCliProcess {
  readonly child: ChildProcessWithoutNullStreams
  private timer?: NodeJS.Timeout
  private controls = new Map<string, { resolve: () => void; reject: (error: Error) => void }>()
  stderr = ''
  constructor(options: CliOptions) {
    const executable = options.executablePath ?? 'claude'
    this.child = spawn(executable, buildCliArgs(options), {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: 'pipe',
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    trackChild(this.child, executable)
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000)
    })
    this.child.stdin.on('error', () => {})
    this.child.once('exit', () => {
      if (this.timer) clearTimeout(this.timer)
    })
  }
  async *messages(): AsyncGenerator<SDKMessage> {
    let error: Error | undefined
    this.child.on('error', (err) => {
      error = err
    })
    for await (const line of createInterface({ input: this.child.stdout, crlfDelay: Infinity })) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.type === 'control_response') {
        const response = message.response
        const pending = this.controls.get(response?.request_id)
        if (pending) {
          this.controls.delete(response.request_id)
          if (response.subtype === 'error') pending.reject(new Error(String(response.error)))
          else pending.resolve()
        }
        continue
      }
      yield message as SDKMessage
    }
    if (this.child.exitCode === null && this.child.signalCode === null && !error) {
      await new Promise<void>((resolve) => this.child.once('close', () => resolve()))
    }
    for (const pending of this.controls.values()) pending.reject(new Error('Claude process ended'))
    this.controls.clear()
    if (error) throw error
    if (this.child.exitCode && this.child.exitCode !== 0)
      throw new Error(`Claude exited with code ${this.child.exitCode}: ${this.stderr.trim()}`)
  }
  async send(text: string, attachments: string[] = [], priority?: 'next') {
    const types: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    }
    const content: unknown = attachments.length
      ? [
          { type: 'text', text },
          ...(await Promise.all(
            attachments.map(async (path) => {
              const media_type = types[extname(path).toLowerCase()]
              if (!media_type) throw new Error(`Unsupported image: ${path}`)
              return {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type,
                  data: (await readFile(path)).toString('base64'),
                },
              }
            }),
          )),
        ]
      : text
    if (!this.child.stdin.writable) throw new Error('Claude process stdin is closed')
    await new Promise<void>((resolve, reject) =>
      this.child.stdin.write(
        JSON.stringify({
          type: 'user',
          message: { role: 'user', content },
          parent_tool_use_id: null,
          ...(priority ? { priority } : {}),
        }) + '\n',
        (err) => (err ? reject(err) : resolve()),
      ),
    )
  }
  async control(request: Record<string, unknown>, timeout = 3000): Promise<void> {
    const id = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.controls.delete(id)
        reject(new Error('Claude control request timed out'))
      }, timeout)
      this.controls.set(id, {
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (error) => {
          clearTimeout(timer)
          reject(error)
        },
      })
      this.child.stdin.write(
        JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n',
        (error) => {
          if (error) {
            this.controls.delete(id)
            clearTimeout(timer)
            reject(error)
          }
        },
      )
    })
  }
  interrupt(timeout = 1000) {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return
    this.child.kill('SIGINT')
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.child.kill('SIGTERM'), timeout)
    this.timer.unref()
  }
  close() {
    this.child.stdin.end()
    if (process.platform !== 'win32' && this.child.pid) {
      try {
        process.kill(-this.child.pid, 'SIGTERM')
        return
      } catch {}
    }
    this.child.kill('SIGTERM')
  }
}
