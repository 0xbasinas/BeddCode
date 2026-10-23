import type { ProviderSession } from './adapter.ts'

/** Consume before prompting: fast providers may finish before prompt() resolves. */
export async function generateSessionText(
  session: ProviderSession,
  prompt: string,
): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Text generation timed out. Try again.')), 120_000)
      void (async () => {
        let text = ''
        for await (const event of session.events) {
          if (event.type === 'message.delta' && event.role === 'assistant') text += event.text
          if (text.length > 64_000) throw new Error('The generated response was too large')
          if (event.type === 'error') throw new Error(event.message)
          if (
            event.type === 'tool.started' ||
            event.type === 'approval.requested' ||
            event.type === 'question.requested'
          ) {
            throw new Error('The agent tried to use a tool instead of generating text. Try again.')
          }
          if (event.type === 'turn.completed') {
            if (event.reason !== 'done' || !text.trim())
              throw new Error('The agent did not return generated text')
            resolve(text.trim())
            return
          }
        }
        reject(new Error('The agent stopped before generating text'))
      })().catch(reject)
      void session.prompt({ text: prompt }).catch(reject)
    })
  } finally {
    clearTimeout(timer)
    await session.close()
  }
}
