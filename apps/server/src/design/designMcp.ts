import type { SessionMcpServer } from '@beddcode/provider-core'

/**
 * Third-party MCP servers given to agents that work on designs, besides BeddCode's own design
 * tools. theSVG looks up brand and logo SVGs, so an agent can place real logos instead of drawing
 * them. It is started with npx the first time a design session needs it.
 */
export function designMcpServers(platform: NodeJS.Platform = process.platform): SessionMcpServer[] {
  const args = ['-y', '@thesvg/mcp-server']
  return [
    {
      name: 'thesvg',
      // On Windows npx is a script (npx.cmd), which cannot be started without a shell.
      ...(platform === 'win32'
        ? { command: 'cmd', args: ['/c', 'npx', ...args] }
        : { command: 'npx', args }),
      env: {},
    },
  ]
}
