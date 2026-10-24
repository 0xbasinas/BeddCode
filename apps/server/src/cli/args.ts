export interface ArgSpec {
  /** Flags that stand alone (`--wait`). */
  bool?: string[]
  /** Flags that take a value (`--agent codex`); repeatable ones collect into an array. */
  string?: string[]
  repeat?: string[]
  /** One-letter forms: `{ n: 'lines' }` makes `-n 5` mean `--lines 5`. */
  alias?: Record<string, string>
}

export interface ParsedArgs {
  flags: Record<string, string | boolean | string[]>
  /** What is left once flags are taken out: the command's own arguments. */
  rest: string[]
}

/**
 * A small flag parser for the commands: `--name value`, `--name=value`, `-n value`, `--flag`, and
 * `--` to end flags. Unknown flags are an error, so a typo is not taken for a message.
 */
export function parseArgs(args: string[], spec: ArgSpec = {}): ParsedArgs {
  const bool = new Set(spec.bool)
  const repeat = new Set(spec.repeat)
  const string = new Set([...(spec.string ?? []), ...repeat])
  const flags: ParsedArgs['flags'] = {}
  const rest: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === '--') {
      rest.push(...args.slice(i + 1))
      break
    }
    const isLong = arg.startsWith('--')
    const isShort = !isLong && /^-[A-Za-z]$/.test(arg)
    if (!isLong && !isShort) {
      rest.push(arg)
      continue
    }
    let name = isLong ? arg.slice(2) : (spec.alias?.[arg.slice(1)] ?? arg.slice(1))
    let inline: string | undefined
    const eq = name.indexOf('=')
    if (isLong && eq > 0) {
      inline = name.slice(eq + 1)
      name = name.slice(0, eq)
    }
    if (bool.has(name)) {
      if (inline !== undefined) throw new Error(`--${name} takes no value`)
      flags[name] = true
    } else if (string.has(name)) {
      const value = inline ?? args[++i]
      if (value === undefined) throw new Error(`--${name} needs a value`)
      if (repeat.has(name)) flags[name] = [...((flags[name] as string[] | undefined) ?? []), value]
      else flags[name] = value
    } else {
      throw new Error(`Unknown option: ${arg}`)
    }
  }
  return { flags, rest }
}

export const str = (v: ParsedArgs['flags'][string] | undefined): string | undefined =>
  typeof v === 'string' ? v : undefined

export function num(v: ParsedArgs['flags'][string] | undefined, name: string): number | undefined {
  if (v === undefined) return undefined
  const n = Number(v)
  if (typeof v !== 'string' || !Number.isFinite(n)) throw new Error(`--${name} needs a number`)
  return n
}
