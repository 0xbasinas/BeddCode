/** Keep an existing draft intact and quote every line so copied Markdown stays inside the quote. */
export function appendReplyQuote(draft: string, text: string, turnNo?: number): string {
  const quote = text
    .trim()
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join('\n')
  return `${draft}${draft ? '\n\n' : ''}Regarding the agent's reply${turnNo ? ` in turn ${turnNo}` : ''}:\n${quote}\n\n`
}
