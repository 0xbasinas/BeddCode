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
