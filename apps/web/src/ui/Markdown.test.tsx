import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown.tsx'

it('streaming splits preserve paragraphs, tables, lists, code and reference links', () => {
  for (const text of [
    'First paragraph.\n\nSecond paragraph.',
    'Intro.\n\n| A | B |\n|---|---|\n| 1 | 2 |',
    'Intro.\n\n- first\n\n- second',
    'Intro.\n\n```ts\nconst a = 1\n\nconst b = 2\n```',
    'An [external link][ref].\n\nMore.\n\n[ref]: https://example.com',
    'Note[^one].\n\nMore.\n\n[^one]: Footnote',
  ]) {
    expect(renderToStaticMarkup(<Markdown text={text} live />)).toBe(
      renderToStaticMarkup(<Markdown text={text} />),
    )
  }
})
