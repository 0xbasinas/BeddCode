import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from '@beddcode/shared'

export const SERVICE_NAME = 'beddcode-server'
const WINDOWS_TASK = 'BeddCode Server'

export interface ServicePlan {
  /** Files to create, with their content. */
  files: { path: string; content: string }[]
  /** Commands that start it now and on every login/boot. */
  install: string[][]
  /** Commands that stop it and remove it. */
  uninstall: string[][]
  /** Files to delete when uninstalling. */
  remove: string[]
  notes: string[]
}

export interface ServicePlanInput {
  platform: NodeJS.Platform
  home: string
  /** The command that runs the server: node, its flags, the entry script. */
  command: string[]
  /** Arguments after `serve`. */
  serveArgs: string[]
}

const systemdQuote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$])/g, '\\$1')}"`
const windowsQuote = (arg: string) =>
  /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`

/**
 * What it takes to run the host in the background on this machine: a systemd user unit on Linux, a
 * scheduled task that starts at logon on Windows. Pure, so it can be shown with --dry-run and tested.
 */
export function planService(input: ServicePlanInput): ServicePlan {
  const args = [...input.command, 'serve', ...input.serveArgs]

  if (input.platform === 'linux') {
    const unitPath = path.posix.join(
      input.home,
      '.config',
      'systemd',
      'user',
      `${SERVICE_NAME}.service`,
    )
    const unit = [
      '[Unit]',
      'Description=BeddCode host',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      `ExecStart=${args.map(systemdQuote).join(' ')}`,
      'Restart=on-failure',
      'RestartSec=3',
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n')
    return {
      files: [{ path: unitPath, content: unit }],
      install: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', `${SERVICE_NAME}.service`],
      ],
      uninstall: [
        ['systemctl', '--user', 'disable', '--now', `${SERVICE_NAME}.service`],
        ['systemctl', '--user', 'daemon-reload'],
      ],
      remove: [unitPath],
      notes: [
        'To keep it running after you log out, run: loginctl enable-linger $USER',
        `Logs: journalctl --user -u ${SERVICE_NAME} -f`,
      ],
    }
  }

  if (input.platform === 'win32') {
    return {
      files: [],
      install: [
        [
          'schtasks',
          '/Create',
          '/TN',
          WINDOWS_TASK,
          '/TR',
          args.map(windowsQuote).join(' '),
          '/SC',
          'ONLOGON',
          '/RL',
          'LIMITED',
          '/F',
        ],
        ['schtasks', '/Run', '/TN', WINDOWS_TASK],
      ],
      uninstall: [
        ['schtasks', '/End', '/TN', WINDOWS_TASK],
        ['schtasks', '/Delete', '/TN', WINDOWS_TASK, '/F'],
      ],
      remove: [],
      notes: ['It starts whenever you sign in to Windows.'],
    }
  }

  throw new Error(`Running as a service is supported on Linux and Windows, not ${input.platform}`)
}

export interface ServiceCommandOptions {
  serveArgs: string[]
  dryRun: boolean
  out?: (line: string) => void
}

/** Command that launches this same server file again (works for `tsx` in development too). */
export function currentCommand(): string[] {
  const entry = process.argv[1]
  if (!entry) throw new Error('Cannot tell how this server was started')
  return [process.execPath, ...process.execArgv, path.resolve(entry)]
}

async function execute(
  commands: string[][],
  out: (line: string) => void,
  tolerateFailure: boolean,
) {
  for (const [file, ...rest] of commands) {
    out(`> ${show([file!, ...rest])}`)
    const result = await runCommand(file!, rest, { timeoutMs: 30_000 })
    if (result.code !== 0 && !tolerateFailure) {
      throw new Error(`${file} failed: ${(result.stderr || result.stdout).trim()}`)
    }
  }
}

export async function installService(options: ServiceCommandOptions): Promise<void> {
  const out = options.out ?? console.log
  const plan = planService({
    platform: process.platform,
    home: os.homedir(),
    command: currentCommand(),
    serveArgs: options.serveArgs,
  })
  for (const file of plan.files) {
    out(`${options.dryRun ? 'Would write' : 'Writing'} ${file.path}:\n${file.content}`)
    if (!options.dryRun) {
      mkdirSync(path.dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.content)
    }
  }
  if (options.dryRun) {
    plan.install.forEach((c) => out(`Would run: ${show(c)}`))
  } else {
    await execute(plan.install, out, false)
  }
  plan.notes.forEach((n) => out(n))
}

export async function uninstallService(options: Pick<ServiceCommandOptions, 'dryRun' | 'out'>) {
  const out = options.out ?? console.log
  const plan = planService({
    platform: process.platform,
    home: os.homedir(),
    command: [],
    serveArgs: [],
  })
  if (options.dryRun) {
    plan.uninstall.forEach((c) => out(`Would run: ${show(c)}`))
    plan.remove.forEach((f) => out(`Would delete ${f}`))
    return
  }
  // Stopping something that is not installed is not an error worth stopping for.
  await execute(plan.uninstall, out, true)
  plan.remove.forEach((f) => rmSync(f, { force: true }))
}

/** A command as it would be typed, for the messages shown to the user. */
const show = (command: string[]) => command.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')
