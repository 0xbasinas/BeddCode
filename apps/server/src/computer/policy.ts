// What an agent may do to a window, decided from what the window is. Kept apart from the tools so it
// can be tested on its own. The tiers follow Claude Code's computer use: browsers are view-only (the
// browser tools are the better way in), terminals and editors are click-only (typing in one is
// shell access), password managers and system prompts are never operable.

export type Tier = 'blocked' | 'view' | 'click' | 'full'

export interface Classification {
  tier: Tier
  /** What the user is told when they are asked to allow the app. */
  warn?: string
}

/** Windows an agent may never operate: they hold the user's secrets or the system's prompts. */
const NEVER =
  /1password|bitwarden|keepass|lastpass|dashlane|nordpass|enpass|credential manager|consent\.exe|logonui|credentialuibroker|windows security|user account control|polkit|gnome-keyring|seahorse|pinentry|kwallet|authentication required/i

const BROWSERS = new Set([
  'chrome',
  'msedge',
  'firefox',
  'brave',
  'opera',
  'vivaldi',
  'iexplore',
  'arc',
  'chromium',
  'tor',
  'zen',
  'google-chrome',
  'chromium-browser',
  'firefox-esr',
  'brave-browser',
  'microsoft-edge',
  'epiphany',
  'librewolf',
])

const TERMINALS_AND_EDITORS = new Set([
  'windowsterminal',
  'wt',
  'cmd',
  'powershell',
  'pwsh',
  'conhost',
  'openconsole',
  'mintty',
  'bash',
  'wsl',
  'wezterm-gui',
  'alacritty',
  'hyper',
  'code',
  'code - insiders',
  'cursor',
  'windsurf',
  'devenv',
  'idea64',
  'pycharm64',
  'webstorm64',
  'rider64',
  'goland64',
  'clion64',
  'studio64',
  'gnome-terminal',
  'gnome-terminal-server',
  'konsole',
  'xterm',
  'kitty',
  'foot',
  'tilix',
  'terminator',
  'xfce4-terminal',
  'lxterminal',
  'ptyxis',
  'ghostty',
  'zsh',
  'fish',
  'sh',
  'gnome-text-editor',
  'gedit',
  'kate',
  'sublime_text',
  'emacs',
  'vim',
  'nvim',
])

const BROAD: Record<string, string> = {
  explorer: 'Can read, move and delete any file.',
  systemsettings: 'Can change system settings.',
  regedit: 'Can change the registry.',
  mmc: 'Can change system settings.',
  taskmgr: 'Can end any program.',
  services: 'Can start and stop system services.',
  control: 'Can change system settings.',
  nautilus: 'Can read, move and delete any file.',
  dolphin: 'Can read, move and delete any file.',
  thunar: 'Can read, move and delete any file.',
  nemo: 'Can read, move and delete any file.',
  'gnome-control-center': 'Can change system settings.',
  systemsettings5: 'Can change system settings.',
  'gnome-system-monitor': 'Can end any program.',
}

const baseName = (app: string) =>
  app
    .toLowerCase()
    .replace(/\.exe$/, '')
    .trim()

export function classify(app: string, title: string): Classification {
  if (NEVER.test(app) || NEVER.test(title)) return { tier: 'blocked' }
  const name = baseName(app)
  if (BROWSERS.has(name)) return { tier: 'view' }
  if (TERMINALS_AND_EDITORS.has(name))
    return { tier: 'click', warn: 'Equivalent to shell access: it may click and scroll, not type.' }
  return { tier: 'full', warn: BROAD[name] }
}

export type Capability = 'read' | 'click' | 'input'

/** Why a tier does not allow a capability, or undefined when it does. */
export function refuse(tier: Tier, app: string, capability: Capability): string | undefined {
  if (capability === 'read' || tier === 'full') return undefined
  if (tier === 'view')
    return `view-only: ${app} is a web browser, which you may only look at here. Use the browser_* tools to operate pages, or ask the user.`
  if (tier === 'click' && capability === 'input')
    return `click-only: ${app} is a terminal or code editor, and typing into one is shell access. You may click and scroll in it; ask the user to type or press keys.`
  return undefined
}

/** The label of an element row: `Button "Seven" [id=num7Button ...]` -> `Seven num7Button`. */
export function labelOf(row: string): string {
  const name = /"((?:[^"\\]|\\.)*)"/.exec(row)?.[1] ?? ''
  const id = /\bid=([^\s\]]+)/.exec(row)?.[1] ?? ''
  return `${name} ${id}`.trim()
}

const ALWAYS_ASK =
  /\b(pay|pay now|buy|buy now|purchase|place (your |my |the )?order|checkout|check out|complete (the )?(order|purchase|payment)|confirm (the )?(order|purchase|payment)|transfer|send money|wire|withdraw|donate|subscribe|delete (my |the )?account|close (my |the )?account|factory reset|format)\b/i

const ASK_BELOW_FULL_ACCESS =
  /\b(delete|remove|uninstall|install|send|submit|publish|post|sign out|log ?out|accept|i agree|agree|allow|grant|confirm|reset|erase|empty|discard|don'?t save|overwrite|replace all)\b/i

/**
 * Clicks that have consequences in the world: money, deletion, consent. Money and accounts are
 * confirmed in every permission mode; the rest unless the user gave the session full access.
 */
export function riskOfClick(row: string): 'always' | 'soft' | undefined {
  const label = labelOf(row)
  if (ALWAYS_ASK.test(label)) return 'always'
  if (ASK_BELOW_FULL_ACCESS.test(label)) return 'soft'
  return undefined
}

const INJECTION = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|prompts|messages)/i,
  /disregard (all |any |the )?(previous|prior|above|earlier|your) (instructions|rules|prompt)/i,
  /\b(new|updated) (instructions|system prompt)\s*:/i,
  /you are (now|actually) (a|an|the)\b/i,
  /<\/?(system|assistant|instructions?)>/i,
  /do not (tell|inform|alert) the user/i,
  /(reveal|print|send|exfiltrate) (your|the) (system prompt|api key|credentials|secrets?)/i,
]

/** On-screen text that reads like orders to an AI model. */
export function looksLikeInjection(text: string): boolean {
  return INJECTION.some((re) => re.test(text))
}

const short = (s: string | undefined, n = 70) =>
  s === undefined ? '(none)' : s.length > n ? `${s.slice(0, n - 1)}…` : s

/** The elements that differ between two reads of a window, most useful few. */
export function changes(
  before: Map<number, string>,
  after: Map<number, string>,
  max = 5,
): { lines: string[]; total: number } {
  const all: string[] = []
  const indexes = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b)
  for (const i of indexes) {
    const a = before.get(i)
    const b = after.get(i)
    if (a === b) continue
    all.push(
      a === undefined
        ? `+ [${i}] ${short(b)}`
        : b === undefined
          ? `- [${i}] ${short(a)}`
          : `~ [${i}] ${short(a)} -> ${short(b)}`,
    )
  }
  return { lines: all.slice(0, max), total: all.length }
}
