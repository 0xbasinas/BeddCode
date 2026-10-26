/** Every command, for tab completion. `sub` are words that follow it; `flags` are its options. */
export interface CommandSpec {
  name: string
  desc: string
  sub?: string[]
  flags?: string[]
}

const HOST = '--host'
const PORT = '--port'

export const SPECS: CommandSpec[] = [
  { name: 'ls', desc: 'List sessions', flags: [HOST, '--all', '--status', '--json', PORT] },
  {
    name: 'run',
    desc: 'Start a session in this folder',
    flags: [
      '--agent',
      '--model',
      '--mode',
      '--effort',
      '--worktree',
      '--no-project',
      '--folder',
      '--title',
      '--wait',
      '--json',
      '--quiet',
      '--no-stdin',
      HOST,
      PORT,
    ],
  },
  { name: 'attach', desc: 'Watch a session live', flags: [HOST, PORT] },
  {
    name: 'send',
    desc: 'Send a message to a session',
    flags: ['--queue', '--no-stdin', HOST, PORT],
  },
  { name: 'stop', desc: 'Interrupt the running turn', flags: [HOST, PORT] },
  {
    name: 'approve',
    desc: 'Answer what the agent is waiting on',
    sub: ['allow', 'deny'],
    flags: [HOST, PORT],
  },
  { name: 'undo', desc: 'Put back what the latest turn changed', flags: ['--yes', HOST, PORT] },
  {
    name: 'schedule',
    desc: 'Prompts the host runs on a timer',
    sub: ['ls', 'runs', 'add', 'run', 'pause', 'resume', 'rm', 'preview'],
    flags: [
      '--name',
      '--agent',
      '--model',
      '--mode',
      '--folder',
      '--session',
      '--worktree',
      '--no-project',
      '--count',
      '--json',
      HOST,
      PORT,
    ],
  },
  { name: 'alert', desc: 'Phone alerts', sub: ['test', 'ls', 'ntfy'], flags: [HOST, PORT] },
  {
    name: 'projects',
    desc: 'Folders added to BeddCode',
    sub: ['ls', 'add', 'rm'],
    flags: ['--json', HOST, PORT],
  },
  { name: 'devices', desc: 'Devices paired with this host', flags: ['--json', HOST, PORT] },
  { name: 'revoke', desc: 'Remove a paired device', flags: [HOST, PORT] },
  {
    name: 'hosts',
    desc: 'Machines this command can talk to',
    sub: ['ls', 'add', 'rm'],
    flags: ['--name'],
  },
  { name: 'config', desc: "The host's settings", sub: ['get', 'set', 'unset'] },
  {
    name: 'metrics',
    desc: 'Speed measurements your relay has collected',
    flags: ['--days', '--json'],
  },
  { name: 'status', desc: 'Is the host running?', flags: [PORT] },
  { name: 'open', desc: 'Start the desktop app', flags: [PORT] },
  { name: 'pair', desc: 'Print a one-time pairing code', flags: [PORT] },
  {
    name: 'logs',
    desc: "Show the host's log",
    flags: ['-n', '--lines', '-f', '--follow', '--level'],
  },
  { name: 'doctor', desc: 'Check this machine and say how to fix it', flags: [PORT] },
  { name: 'report', desc: 'Write a report for a bug report', flags: ['--out', '--print', PORT] },
  { name: 'update', desc: 'Check for a newer release', flags: ['--download', '--out', '--deb'] },
  {
    name: 'completion',
    desc: 'Tab completion for your shell',
    sub: ['bash', 'zsh', 'fish', 'powershell'],
  },
  {
    name: 'host',
    desc: 'Run the host in the background',
    sub: ['install', 'uninstall'],
    flags: [PORT, '--host', '--allow-lan', '--dry-run'],
  },
  {
    name: 'serve',
    desc: 'Run the host in this terminal',
    flags: [PORT, '--host', '--allow-lan', '--require-token', '--allow-origin'],
  },
  {
    name: 'install-service',
    desc: 'Run the host in the background',
    flags: [PORT, '--host', '--allow-lan', '--dry-run'],
  },
  { name: 'uninstall-service', desc: 'Remove the background host', flags: ['--dry-run'] },
]

export const SHELLS = ['bash', 'zsh', 'fish', 'powershell'] as const
export type Shell = (typeof SHELLS)[number]

const names = SPECS.map((s) => s.name)
const words = (s: CommandSpec) => [...(s.sub ?? []), ...(s.flags ?? [])].join(' ')

function bash(): string {
  const cases = SPECS.filter((s) => s.sub || s.flags)
    .map((s) => {
      const subs = (s.sub ?? []).join(' ')
      const rest = words(s)
      return subs
        ? `    ${s.name}) if [ "$COMP_CWORD" -eq 2 ]; then words="${subs}"; else words="${rest}"; fi ;;`
        : `    ${s.name}) words="${rest}" ;;`
    })
    .join('\n')
  return `# beddcode tab completion. Load it with: eval "$(beddcode completion bash)"
_beddcode() {
  local cur="\${COMP_WORDS[COMP_CWORD]}" words=""
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${names.join(' ')}" -- "$cur") )
    return
  fi
  case "\${COMP_WORDS[1]}" in
${cases}
  esac
  COMPREPLY=( $(compgen -W "$words" -- "$cur") )
}
complete -F _beddcode beddcode
`
}

function zsh(): string {
  const cases = SPECS.filter((s) => s.sub || s.flags)
    .map((s) => {
      const subs = (s.sub ?? []).join(' ')
      const rest = words(s)
      return subs
        ? `    ${s.name}) if (( CURRENT == 3 )); then compadd -- ${subs}; else compadd -- ${rest}; fi ;;`
        : `    ${s.name}) compadd -- ${rest} ;;`
    })
    .join('\n')
  return `#compdef beddcode
# beddcode tab completion. Load it with: eval "$(beddcode completion zsh)"
_beddcode() {
  if (( CURRENT == 2 )); then
    compadd -- ${names.join(' ')}
    return
  fi
  case "$words[2]" in
${cases}
  esac
}
compdef _beddcode beddcode
`
}

function fish(): string {
  const lines = [
    '# beddcode tab completion. Save it with: beddcode completion fish > ~/.config/fish/completions/beddcode.fish',
  ]
  for (const s of SPECS) {
    lines.push(
      `complete -c beddcode -n '__fish_use_subcommand' -a '${s.name}' -d '${s.desc.replace(/'/g, '')}'`,
    )
    for (const sub of s.sub ?? []) {
      lines.push(`complete -c beddcode -n '__fish_seen_subcommand_from ${s.name}' -a '${sub}'`)
    }
    for (const f of s.flags ?? []) {
      const long = f.startsWith('--') ? `-l ${f.slice(2)}` : `-s ${f.slice(1)}`
      lines.push(`complete -c beddcode -n '__fish_seen_subcommand_from ${s.name}' ${long}`)
    }
  }
  return `${lines.join('\n')}\n`
}

function powershell(): string {
  const table = SPECS.map(
    (s) => `  '${s.name}' = @('${[...(s.sub ?? []), ...(s.flags ?? [])].join("','")}')`,
  ).join('\n')
  return `# beddcode tab completion. Load it with: beddcode completion powershell | Out-String | Invoke-Expression
$beddcodeWords = @{
${table}
}
Register-ArgumentCompleter -Native -CommandName beddcode -ScriptBlock {
  param($wordToComplete, $commandAst)
  $tokens = @($commandAst.CommandElements | ForEach-Object { $_.ToString() })
  $candidates = if ($tokens.Count -le 1 -or ($tokens.Count -eq 2 -and $wordToComplete)) {
    $beddcodeWords.Keys | Sort-Object
  } else {
    $beddcodeWords[$tokens[1]]
  }
  $candidates | Where-Object { $_ -like "$wordToComplete*" } |
    ForEach-Object { [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_) }
}
`
}

export function completionScript(shell: string): string {
  switch (shell) {
    case 'bash':
      return bash()
    case 'zsh':
      return zsh()
    case 'fish':
      return fish()
    case 'powershell':
    case 'pwsh':
      return powershell()
    default:
      throw new Error(`Shells: ${SHELLS.join(', ')}`)
  }
}
