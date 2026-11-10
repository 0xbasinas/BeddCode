import type { RpcResult } from '@beddcode/contracts'
import { Button } from '@/components/ui/button'

type Report = RpcResult<'agents.inspect'>
type Check = { loading?: boolean; data?: Report; error?: string }

const groups = [
  {
    name: 'Conversation',
    items: [
      ['steering', 'Live steering', 'Send an instruction into a running turn.'],
      ['load', 'Load conversation', 'Reopen with conversation history.'],
      ['resume', 'Resume session', 'Reconnect to an existing session.'],
      ['list', 'List sessions', 'Find conversations stored by the agent.'],
      ['close', 'Close session', 'Ask the agent to close a session.'],
    ],
  },
  {
    name: 'Input',
    items: [
      ['images', 'Images', 'Send images as ACP content blocks.'],
      ['audio', 'Audio', 'The agent accepts audio; BeddCode does not send it yet.'],
      [
        'embeddedContext',
        'Embedded context',
        'The agent accepts embedded context; BeddCode does not send it yet.',
      ],
    ],
  },
  {
    name: 'MCP transports',
    items: [
      ['mcpHttp', 'HTTP', 'BeddCode currently supplies stdio MCP servers.'],
      ['mcpSse', 'SSE', 'BeddCode currently supplies stdio MCP servers.'],
    ],
  },
] as const

const beddcodeFeatures = new Set(['steering', 'load', 'resume', 'list', 'close', 'images'])

export function AgentCapabilities({
  label,
  check,
  online,
  onCheck,
}: {
  label: string
  check?: Check
  online: boolean
  onCheck(): void
}) {
  const report = check?.data
  return (
    <section className="agent-capabilities" aria-label={`${label} ACP capabilities`}>
      <div className="agent-capabilities-heading">
        <div>
          <h4>ACP capabilities</h4>
          <p>Check what this installed agent advertises. No session is created.</p>
        </div>
        <Button
          variant="app"
          className="settings-button"
          disabled={!online || check?.loading}
          onClick={onCheck}
        >
          {check?.loading ? 'Checking…' : report ? 'Check again' : 'Check connection'}
        </Button>
      </div>
      {check?.error && (
        <p className="settings-error" role="alert">
          Check failed: {check.error}
        </p>
      )}
      {!report && !check?.loading && !check?.error && (
        <p className="agent-capabilities-empty">
          Capabilities are unknown until you check this agent.
        </p>
      )}
      {check?.loading && (
        <p className="agent-capabilities-empty" role="status">
          Waiting for the agent to initialize…
        </p>
      )}
      {report && (
        <>
          <p className="agent-capabilities-meta">
            {report.name ?? label}
            {report.version ? ` ${report.version}` : ''} · ACP v{report.protocolVersion} · Checked{' '}
            {new Date(report.checkedAt).toLocaleString()}
          </p>
          <details className="agent-capabilities-details">
            <summary>Executable and check details</summary>
            <p>Executable: {report.executable}</p>
            <p>Working directory: {report.cwd}</p>
            <p>
              Authentication methods advertised: {report.authMethods}. This check does not verify
              sign-in.
            </p>
          </details>
          <p className="agent-capabilities-note">
            These are the agent’s advertised features. Actual availability can vary by session.
            Follow-ups are queued by BeddCode.
          </p>
          <p className="agent-capabilities-note">
            This restricted diagnostic advertises no filesystem or terminal support; a live session
            advertises both. Capabilities are advertised, not verified by running a task.
          </p>
          {report.raw !== undefined && (
            <details className="agent-capabilities-details">
              <summary>Raw advertised capability structure (values redacted)</summary>
              <pre style={{ overflowX: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                {JSON.stringify(report.raw, null, 2)}
              </pre>
            </details>
          )}
          {groups.map((group) => (
            <div className="agent-capabilities-group" key={group.name}>
              <h5>{group.name}</h5>
              <dl>
                {group.items.map(([key, name, description]) => (
                  <div className="agent-capabilities-item" key={key}>
                    <dt>
                      <span>{name}</span>
                      <small>{description}</small>
                    </dt>
                    <dd className={report.features[key] === true ? 'is-advertised' : ''}>
                      {report.features[key] === undefined
                        ? 'Unknown'
                        : report.features[key]
                          ? 'Advertised'
                          : 'Not advertised'}
                      <br />
                      <small>
                        {beddcodeFeatures.has(key)
                          ? 'BeddCode supports'
                          : 'Not implemented in BeddCode'}
                      </small>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </>
      )}
    </section>
  )
}
