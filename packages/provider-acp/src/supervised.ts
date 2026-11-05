import type { StartSessionInput } from '@beddcode/provider-core'
import {
  openSupervisedTransport,
  type Logger,
  type SupervisedHandshake,
  type SupervisorClient,
  type Transport,
} from '@beddcode/shared'

/**
 * What an ACP agent that is reattached is not told twice: `initialize`, signing in, and opening its
 * session (a new one, a resumed one and a loaded one are all "the session is open"), which it did
 * for the previous host.
 */
export const ACP_HANDSHAKE: SupervisedHandshake = {
  memo: [['initialize'], ['authenticate'], ['session/new', 'session/load', 'session/resume']],
}

/**
 * The transport for an ACP session: under the supervisor when there is one (so the agent outlives a
 * host restart), otherwise the plain one `plain` makes. One-off text jobs are never supervised.
 */
export async function acpTransport(options: {
  supervisor?: SupervisorClient
  input: StartSessionInput
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  log: Logger
  name: string
  plain: () => Transport
}): Promise<Transport> {
  if (!options.supervisor || options.input.textOnly) return options.plain()
  return openSupervisedTransport(
    options.supervisor,
    options.input.sessionId,
    {
      command: options.command,
      args: options.args,
      cwd: options.input.cwd,
      env: options.env,
      handshake: ACP_HANDSHAKE,
    },
    { reattach: options.input.reattach, log: options.log, name: options.name },
  )
}
