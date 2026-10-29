import os from 'node:os'
import { describe, expect, it } from 'vitest'
import { TerminalManager, tailBytes } from './terminals.ts'

const node = process.execPath

describe('ACP terminals', () => {
  it('keeps a multi-byte character whole when it arrives in two chunks', async () => {
    const terms = new TerminalManager(os.tmpdir())
    const script =
      'const b = Buffer.from("Γειά 👋"); process.stdout.write(b.subarray(0, 3)); setTimeout(() => process.stdout.write(b.subarray(3)), 50)'
    const { terminalId } = terms.create({ command: node, args: ['-e', script] })
    await terms.waitForExit(terminalId)
    await new Promise((r) => setTimeout(r, 20))
    expect(terms.output(terminalId).output).toBe('Γειά 👋')
    terms.releaseAll()
  })

  it('keeps only the tail of endless output when the agent sets no limit', async () => {
    const terms = new TerminalManager(os.tmpdir())
    const script =
      'const s = "λ".repeat(1 << 20); for (let i = 0; i < 6; i++) process.stdout.write(s); process.stdout.write("end")'
    const { terminalId } = terms.create({
      command: node,
      args: ['-e', script],
      outputByteLimit: null,
    })
    await terms.waitForExit(terminalId)
    await new Promise((r) => setTimeout(r, 50))
    const { output, truncated } = terms.output(terminalId)
    expect(truncated).toBe(true)
    expect(Buffer.byteLength(output)).toBeLessThanOrEqual(4 * 1024 * 1024)
    expect(output.endsWith('end')).toBe(true)
    expect(output).not.toContain('\ufffd')
    terms.releaseAll()
  })

  it('cuts the tail on a character boundary', () => {
    expect(tailBytes('aλb', 2)).toBe('b')
    expect(tailBytes('aλb', 3)).toBe('λb')
    expect(tailBytes('short', 10)).toBe('short')
  })
})
