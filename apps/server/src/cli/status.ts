import { fetchHealth } from './health.ts'

/** `beddcode status`: is the host up, and which one. Exit code 1 when it is not. */
export async function status(port: number, out: (line: string) => void = console.log) {
  const health = await fetchHealth(port)
  if (!health) {
    out(`No host is answering on port ${port}.`)
    out('Start the BeddCode app, or run `beddcode serve`.')
    return 1
  }
  out(`${health.name} is running on port ${port}`)
  out(`  version ${health.version} · ${health.platform} · protocol ${health.protocol}`)
  return 0
}
