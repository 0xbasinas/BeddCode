import { describe, expect, it } from 'vitest'
import { hostStatus } from './status.ts'

const health = { name: 'box', version: '1.2.3', platform: 'linux', protocol: 1 }

async function run(installed: boolean, answering: boolean, platform: NodeJS.Platform = 'linux') {
  const lines: string[] = []
  const code = await hostStatus(3773, {
    platform,
    installed: async () => installed,
    health: async () => (answering ? health : null),
    out: (line) => lines.push(line),
  })
  return { code, text: lines.join('\n') }
}

describe('hostStatus', () => {
  it('is 0 when a host answers', async () => {
    const { code, text } = await run(true, true)
    expect(code).toBe(0)
    expect(text).toContain('installed (user service beddcode-server)')
    expect(text).toContain('box answers on port 3773 (1.2.3)')
  })

  it('is 3, with how to start it, when installed but not answering', async () => {
    const { code, text } = await run(true, false, 'win32')
    expect(code).toBe(3)
    expect(text).toContain('scheduled task "BeddCode Server"')
    expect(text).toContain('schtasks /Run /TN "BeddCode Server"')
  })

  it('is 1 when neither', async () => {
    const { code, text } = await run(false, false)
    expect(code).toBe(1)
    expect(text).toContain('not installed')
  })
})
