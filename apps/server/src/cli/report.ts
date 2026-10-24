import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveExecutable, runCommand } from '@beddcode/shared'
import { dataHome } from '../hostIdentity.ts'
import { TailscaleService } from '../network/tailscale.ts'
import { VERSION } from '../version.ts'
import { doctor, formatChecks } from './doctor.ts'
import { fetchHealth } from './health.ts'
import { hostLogPath, tail } from './logs.ts'
import type { Ctx } from './sessionCmds.ts'
import { parseArgs } from './args.ts'

/** Takes out what should not be pasted into a public issue: secrets, codes and the user's name. */
export function redact(text: string, home = os.homedir()): string {
  let out = text
  if (home.length > 3) {
    const forms = new Set([home, home.replaceAll('\\', '/'), home.replaceAll('\\', '\\\\')])
    for (const form of forms) out = out.split(form).join('~')
  }
  return out
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[redacted]')
    .replace(
      /(\b(?:token|secret|password|passwd|api[_-]?key|authorization|code)["']?\s*[:=]\s*["']?)[^\s"',}&]{6,}/gi,
      '$1[redacted]',
    )
    .replace(/([?&](?:token|code|key)=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/\b(?:sk|ghp|gho|ghs|xox[a-z])-?[A-Za-z0-9_-]{16,}/g, '[redacted]')
}

export interface ReportInput {
  version: string
  platform: string
  node: string
  checks: string
  log: string
  now: Date
}

export function formatReport(input: ReportInput): string {
  return [
    '# BeddCode report',
    '',
    `Date:     ${input.now.toISOString()}`,
    `BeddCode: ${input.version}`,
    `System:   ${input.platform}`,
    `Node:     ${input.node}`,
    '',
    '## Doctor',
    input.checks,
    '',
    '## Recent host log',
    input.log || '(no log)',
    '',
  ].join('\n')
}

/** `beddcode report`: everything a bug report needs, with secrets removed, in one file. */
export async function reportCmd(args: string[], ctx: Ctx): Promise<number> {
  const { flags } = parseArgs(args, { bool: ['print'], string: ['out'] })
  const checks = await doctor({
    port: ctx.port,
    health: fetchHealth,
    find: (name) => resolveExecutable(name),
    run: (file, a) => runCommand(file, a, { timeoutMs: 8000 }),
    tailnet: () => new TailscaleService().status(),
    dataDir: dataHome(),
    dirExists: existsSync,
  })
  const logFile = hostLogPath()
  const log = existsSync(logFile) ? tail(readFileSync(logFile, 'utf8'), 200) : ''
  const report = redact(
    formatReport({
      version: VERSION,
      platform: `${os.type()} ${os.release()} (${process.platform} ${process.arch})`,
      node: process.version,
      checks: formatChecks(checks),
      log,
      now: new Date(),
    }),
  )
  if (flags.print === true) {
    ctx.io.out(`${report}\n`)
    return 0
  }
  const out =
    typeof flags.out === 'string'
      ? flags.out
      : path.resolve(`beddcode-report-${new Date().toISOString().slice(0, 10)}.txt`)
  writeFileSync(out, report)
  ctx.io.err(
    `Wrote ${out}\nLook it over, then attach it to the issue. Tokens, codes and your home folder are already removed.\n`,
  )
  return 0
}
