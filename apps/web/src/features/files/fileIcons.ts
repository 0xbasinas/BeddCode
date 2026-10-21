/** Short label shown on a file's icon, from its extension. */
const LABELS: Record<string, string> = {
  ts: 'TS',
  tsx: 'TS',
  js: 'JS',
  jsx: 'JS',
  mjs: 'JS',
  cjs: 'JS',
  json: '{}',
  md: 'MD',
  css: 'CSS',
  html: 'HTML',
  py: 'PY',
  rs: 'RS',
  go: 'GO',
  yml: 'YML',
  yaml: 'YML',
  toml: 'TOML',
  sh: 'SH',
  sql: 'SQL',
}

export function fileLabel(name: string): string {
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return ''
  const ext = name.slice(dot + 1).toLowerCase()
  return LABELS[ext] ?? ''
}

/** Human-readable language name for the status bar. */
const LANGUAGES: Record<string, string> = {
  ts: 'TypeScript',
  tsx: 'TypeScript',
  js: 'JavaScript',
  jsx: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  json: 'JSON',
  md: 'Markdown',
  css: 'CSS',
  html: 'HTML',
  py: 'Python',
  rs: 'Rust',
  go: 'Go',
  yml: 'YAML',
  yaml: 'YAML',
  toml: 'TOML',
  sh: 'Shell',
  sql: 'SQL',
}

export function languageName(name: string): string {
  const dot = name.lastIndexOf('.')
  return (dot > 0 && LANGUAGES[name.slice(dot + 1).toLowerCase()]) || 'Plain text'
}

export const baseName = (path: string) => path.split('/').at(-1) ?? path
