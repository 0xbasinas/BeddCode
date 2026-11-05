// A stand-in for the `claude` CLI in stream-json mode, for the supervisor tests: it answers the SDK's
// handshake and, for each user message, "works" for a while (one message per tick) before its result.
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const state = process.env.FAKE_STATE
const parts = Number(process.env.FAKE_PARTS ?? 8)
const tick = Number(process.env.FAKE_TICK_MS ?? 250)
if (state) {
  fs.writeFileSync(path.join(state, 'pid'), String(process.pid))
  fs.appendFileSync(path.join(state, 'starts'), 'x')
}
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n')

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line)
  if (msg.type === 'control_request') {
    out({
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: msg.request_id,
        response:
          msg.request.subtype === 'initialize'
            ? {
                commands: [],
                agents: [],
                output_style: 'default',
                available_output_styles: [],
                models: [],
              }
            : {},
      },
    })
  } else if (msg.type === 'user') {
    out({ type: 'system', subtype: 'init', session_id: 'sess-1' })
    for (let i = 1; i <= parts; i++) {
      await new Promise((r) => setTimeout(r, tick))
      out({
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: `m${i}`,
          role: 'assistant',
          content: [{ type: 'text', text: `part ${i};` }],
        },
      })
    }
    out({
      type: 'result',
      subtype: 'success',
      is_error: false,
      result: 'done',
      session_id: 'sess-1',
      num_turns: 1,
      duration_ms: 1,
      total_cost_usd: 0,
      usage: {},
    })
  }
})
process.stdin.on('end', () => process.exit(0))
