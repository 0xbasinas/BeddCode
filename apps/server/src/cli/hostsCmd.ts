import { parseArgs, str } from './args.ts'
import { addHost, hostsFile, loadSaved, LOCAL_NAME, pairRemote, saveHosts } from './hosts.ts'
import type { Io } from './io.ts'

/**
 * `beddcode hosts`: the machines this command line can talk to.
 *   hosts                       list them
 *   hosts add <address> <code>  pair with another machine (`beddcode pair` there prints the code)
 *   hosts rm <name>             forget one (it still lists this device until revoked there)
 */
export async function hostsCmd(args: string[], io: Io, file = hostsFile()): Promise<number> {
  const { flags, rest } = parseArgs(args, { string: ['name'] })
  const [action = 'ls', ...more] = rest
  const saved = loadSaved(file)

  if (action === 'ls') {
    io.out(`${LOCAL_NAME}  (this machine)\n`)
    for (const h of saved) io.out(`${h.name}  ${h.urls[0]}\n`)
    return 0
  }
  if (action === 'add') {
    const [address, code] = more
    if (!address || !code) {
      throw new Error('Usage: beddcode hosts add <address> <code> [--name <name>]')
    }
    const target = await pairRemote(address, code, str(flags.name))
    saveHosts(addHost(saved, target), file)
    io.err(`Paired with ${target.name}. Use it with --host ${target.name}.\n`)
    return 0
  }
  if (action === 'rm') {
    const name = more[0]
    if (!name) throw new Error('Usage: beddcode hosts rm <name>')
    if (!saved.some((h) => h.name === name)) throw new Error(`No paired host named "${name}".`)
    saveHosts(
      saved.filter((h) => h.name !== name),
      file,
    )
    io.err(`Forgot ${name}.\n`)
    return 0
  }
  throw new Error(`Unknown: beddcode hosts ${action}. Try ls, add or rm.`)
}
