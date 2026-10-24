/** A workspace is a folder on one host: the same path on two hosts is two workspaces. */
export const workspaceKey = (hostKey: string, projectPath: string) => `${hostKey}\n${projectPath}`

/** Sessions that run outside any added folder share this one. */
export const NO_PROJECT = 'no-project'

/** A steady hue for a workspace's icon, so each folder keeps its colour between runs. */
export function workspaceHue(name: string): number {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return hash % 360
}

/** One or two letters for a workspace's icon. */
export function workspaceInitials(name: string): string {
  const words = name.split(/[\s._-]+/).filter(Boolean)
  const letters =
    words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : (words[0] ?? name).slice(0, 2)
  return letters.toUpperCase() || '?'
}
