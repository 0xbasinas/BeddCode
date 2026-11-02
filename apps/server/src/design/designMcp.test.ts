import { describe, expect, it } from 'vitest'
import { designMcpServers } from './designMcp.ts'

describe('designMcpServers', () => {
  it('starts theSVG with npx, through cmd on Windows', () => {
    expect(designMcpServers('linux')).toEqual([
      { name: 'thesvg', command: 'npx', args: ['-y', '@thesvg/mcp-server'], env: {} },
    ])
    expect(designMcpServers('win32')[0]).toMatchObject({
      command: 'cmd',
      args: ['/c', 'npx', '-y', '@thesvg/mcp-server'],
    })
  })
})
