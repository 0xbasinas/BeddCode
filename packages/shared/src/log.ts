export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface Logger {
  debug(msg: string, data?: unknown): void
  info(msg: string, data?: unknown): void
  warn(msg: string, data?: unknown): void
  error(msg: string, data?: unknown): void
}

const order: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export function createLogger(scope: string, min: LogLevel = 'info'): Logger {
  const emit = (level: LogLevel) => (msg: string, data?: unknown) => {
    if (order[level] < order[min]) return
    const line = `${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}`
    const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log
    if (data === undefined) sink(line)
    else sink(line, data)
  }
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') }
}
