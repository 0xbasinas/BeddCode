import readline from 'node:readline'

/** What the commands print and ask; replaced by a fake in tests. */
export interface Io {
  /** The answer itself (stdout), so `beddcode run --wait > reply.md` holds only that. */
  out(text: string): void
  /** Progress and prompts (stderr). */
  err(text: string): void
  /** A person is at the keyboard: questions can be asked. */
  interactive: boolean
  /**
   * Asks for a line. When several are waiting, the newest gets the next line: a question asked
   * while a command sits at its own prompt is answered first.
   */
  ask(question: string): Promise<string>
  /** Lets go of the keyboard so the process can end. */
  close?(): void
}

export function realIo(): Io {
  let rl: readline.Interface | null = null
  const waiting: ((line: string) => void)[] = []
  const buffered: string[] = []
  const reader = () => {
    if (rl) return rl
    rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: false })
    rl.on('line', (line) => {
      const next = waiting.pop()
      if (next) next(line.trim())
      else buffered.push(line.trim())
    })
    rl.on('close', () => {
      while (waiting.length > 0) waiting.pop()!('')
    })
    return rl
  }
  return {
    out: (text) => void process.stdout.write(text),
    err: (text) => void process.stderr.write(text),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    ask(question) {
      reader()
      if (question) process.stderr.write(question)
      const early = buffered.shift()
      if (early !== undefined) return Promise.resolve(early)
      return new Promise((resolve) => waiting.push(resolve))
    },
    close() {
      rl?.close()
      rl = null
    },
  }
}

/** Everything piped into this process, or null when stdin is the keyboard. */
export async function readStdin(): Promise<string | null> {
  if (process.stdin.isTTY) return null
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  return text.length > 0 ? text : null
}
