import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runCommand } from '@beddcode/shared'

export const SERVICE_NAME = 'beddcode-server'
export const WINDOWS_TASK = 'BeddCode Server'

export interface ServicePlan {
  /** Files to create, with their content (UTF-16 with a byte order mark when `utf16`). */
  files: { path: string; content: string; utf16?: boolean }[]
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
  /** Variables the host needs, such as ELECTRON_RUN_AS_NODE when the app's own runtime runs it. */
  env?: Record<string, string>
  /** The account it runs as, `DOMAIN\\user` on Windows (where the task names it). */
  user?: string
  /**
   * Start with the machine rather than at sign-in: Windows registers the task to run whether or not
   * anyone is signed in (that needs an administrator terminal), Linux keeps the user's services
   * running without a session (loginctl enable-linger).
   */
  atBoot?: boolean
}

/** The variables a service must be started with, when this process was started with them. */
export function serviceEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of ['ELECTRON_RUN_AS_NODE', 'BEDDCODE_WEB_ROOT']) {
    if (source[name]) env[name] = source[name]!
  }
  return env
}

const systemdQuote = (arg: string) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$])/g, '\\$1')}"`
const windowsQuote = (arg: string) =>
  /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '\\"')}"`

/** Where the task definition is kept on Windows (schtasks reads it from a file). */
export const windowsTaskFile = (home: string) =>
  path.win32.join(home, 'AppData', 'Local', 'BeddCode', 'host-task.xml')

const xmlEscape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/**
 * The scheduled task, as Task Scheduler's XML (schtasks' own flags cannot set most of this):
 * - the host runs under `conhost --headless`, so no console window opens (or can be closed by
 *   mistake, which would stop the host), even where Windows Terminal is the default terminal,
 * - no run-time limit (tasks are stopped after 72 hours by default), restarted when it fails,
 *   kept running on battery, at normal priority,
 * - started at sign-in, or with `atBoot` whether or not anyone is signed in.
 */
export function windowsTaskXml(input: ServicePlanInput): string {
  const args = [...input.command, 'serve', ...input.serveArgs].map(windowsQuote).join(' ')
  const env = Object.entries(input.env ?? {})
  // A scheduled task has no environment of its own, so cmd sets it first (still without a window).
  const run =
    env.length > 0
      ? `cmd.exe /d /c "${env.map(([k, v]) => `set "${k}=${v}"`).join(' && ')} && ${args}"`
      : args
  const user = input.user ? `<UserId>${xmlEscape(input.user)}</UserId>` : ''
  const trigger = input.atBoot
    ? '<BootTrigger><Enabled>true</Enabled></BootTrigger>'
    : `<LogonTrigger><Enabled>true</Enabled>${user}</LogonTrigger>`
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo><Description>BeddCode host</Description></RegistrationInfo>',
    `  <Triggers>${trigger}</Triggers>`,
    '  <Principals>',
    `    <Principal id="Author">${user}<LogonType>${input.atBoot ? 'S4U' : 'InteractiveToken'}</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal>`,
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>5</Priority>',
    '    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    `    <Exec><Command>%SystemRoot%\\System32\\conhost.exe</Command><Arguments>${xmlEscape(`--headless ${run}`)}</Arguments></Exec>`,
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n')
}

/**
 * What it takes to run the host in the background on this machine: a systemd user unit on Linux, a
 * scheduled task that starts at logon on Windows. Pure, so it can be shown with --dry-run and tested.
 */
export function planService(input: ServicePlanInput): ServicePlan {
  const args = [...input.command, 'serve', ...input.serveArgs]
  const env = Object.entries(input.env ?? {})

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
      ...env.map(([k, v]) => `Environment=${systemdQuote(`${k}=${v}`)}`),
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
        // Keeps the user's services running without a session, so the host starts with the machine.
        ...(input.atBoot && input.user ? [['loginctl', 'enable-linger', input.user]] : []),
      ],
      uninstall: [
        ['systemctl', '--user', 'disable', '--now', `${SERVICE_NAME}.service`],
        ['systemctl', '--user', 'daemon-reload'],
      ],
      remove: [unitPath],
      notes: [
        input.atBoot
          ? 'It starts with the machine and keeps running after you log out.'
          : 'To keep it running after you log out, add --at-boot or run: loginctl enable-linger $USER',
        `Logs: journalctl --user -u ${SERVICE_NAME} -f`,
      ],
    }
  }

  if (input.platform === 'win32') {
    const xmlPath = windowsTaskFile(input.home)
    return {
      files: [{ path: xmlPath, content: windowsTaskXml(input), utf16: true }],
      install: [
        ['schtasks', '/Create', '/TN', WINDOWS_TASK, '/XML', xmlPath, '/F'],
        ['schtasks', '/Run', '/TN', WINDOWS_TASK],
      ],
      uninstall: [
        ['schtasks', '/End', '/TN', WINDOWS_TASK],
        ['schtasks', '/Delete', '/TN', WINDOWS_TASK, '/F'],
      ],
      remove: [xmlPath],
      notes: [
        input.atBoot
          ? 'It starts with Windows, whether or not anyone is signed in.'
          : 'It starts whenever you sign in to Windows (add --at-boot, in an administrator terminal, to start it with Windows instead).',
        'It runs without a window; `beddcode host status` and `beddcode logs` show how it is doing.',
      ],
    }
  }

  throw new Error(`Running as a service is supported on Linux and Windows, not ${input.platform}`)
}

export interface ServiceCommandOptions {
  serveArgs: string[]
  dryRun: boolean
  atBoot?: boolean
  out?: (line: string) => void
}

/** The account the service runs as: `DOMAIN\\user` on Windows, the user name elsewhere. */
export function currentUser(env: NodeJS.ProcessEnv = process.env): string {
  const name = os.userInfo().username
  return process.platform === 'win32' && env.USERDOMAIN ? `${env.USERDOMAIN}\\${name}` : name
}

/** Whether the background host is installed: the task or the user unit exists. */
export async function serviceInstalled(
  platform: NodeJS.Platform = process.platform,
  run: typeof runCommand = runCommand,
): Promise<boolean> {
  try {
    if (platform === 'win32') {
      return (
        (await run('schtasks', ['/Query', '/TN', WINDOWS_TASK], { timeoutMs: 10_000 })).code === 0
      )
    }
    if (platform === 'linux') {
      const res = await run('systemctl', ['--user', 'is-enabled', `${SERVICE_NAME}.service`], {
        timeoutMs: 10_000,
      })
      return res.code === 0
    }
  } catch {
    // no schtasks or systemctl here
  }
  return false
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
    env: serviceEnv(),
    user: currentUser(),
    atBoot: options.atBoot,
  })
  for (const file of plan.files) {
    out(`${options.dryRun ? 'Would write' : 'Writing'} ${file.path}:\n${file.content}`)
    if (!options.dryRun) {
      mkdirSync(path.dirname(file.path), { recursive: true })
      writeFileSync(
        file.path,
        file.utf16 ? Buffer.from(`\ufeff${file.content}`, 'utf16le') : file.content,
      )
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
