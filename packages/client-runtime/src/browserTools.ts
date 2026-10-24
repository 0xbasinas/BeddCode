import { BROWSER_TOOL_NAMES, type BrowserToolName } from '@beddcode/contracts'
import { looseJson } from './agentTools.ts'
import type { Tool } from './toolSummary.ts'

// Browser use in the conversation: an agent's browser_* calls (see the host's browserUse.ts) get
// cards that say what it did on which page, with a small picture of the page after it.

const NAMES = BROWSER_TOOL_NAMES.join('|')
/** "Using beddcode · browser_click", "mcp__beddcode__browser_click", "beddcode/browser_click"… */
const TITLE = new RegExp(`beddcode\\s*(?:·|:|/|\\.|__|_|-)\\s*(${NAMES})\\b`, 'i')
/** The bare name, maybe with a server prefix of the agent's own, maybe with arguments after. */
const BARE = new RegExp(`^(?:\\S+?(?:__|/|\\.|:)\\s*)?(${NAMES})(?:\\s*[:(].*)?$`, 'i')

type Named = Pick<Tool, 'title'> & { input?: string }

export function browserToolName(tool: Named): BrowserToolName | undefined {
  const title = tool.title.trim()
  const hit = TITLE.exec(title) ?? BARE.exec(title)
  if (hit) return hit[1]!.toLowerCase() as BrowserToolName
  // Grok's use_tool before its title catches up: the name is in the input.
  if (/^use_tool$/i.test(title) && tool.input) {
    const named = looseJson(tool.input).tool_name
    if (typeof named === 'string') {
      const inner = TITLE.exec(named)
      if (inner) return inner[1]!.toLowerCase() as BrowserToolName
    }
  }
  return undefined
}

export const isBrowserTool = (tool: Named) => browserToolName(tool) !== undefined

export interface BrowserToolView {
  name: BrowserToolName
  /** What it does or did, in a few words: "Click e7", "Clicked button "Place order"". */
  summary: string
  /** The page it acted on: title and address, when the answer says. */
  page?: { title?: string; url: string }
  /** A picture saved on the host (absolute path), from the answer's `image:` line. */
  image?: string
  /** The answer's text without the lines shown elsewhere. */
  detail: string
  /** The call failed (its detail says why). */
  failed: boolean
}

const VERB: Record<BrowserToolName, string> = {
  browser_tabs: 'Tabs',
  browser_navigate: 'Open',
  browser_back: 'Back',
  browser_forward: 'Forward',
  browser_reload: 'Reload',
  browser_snapshot: 'Read page',
  browser_click: 'Click',
  browser_type: 'Type',
  browser_press_key: 'Press',
  browser_hover: 'Hover',
  browser_select_option: 'Pick',
  browser_scroll: 'Scroll',
  browser_wait_for: 'Wait for',
  browser_screenshot: 'Screenshot',
  browser_console: 'Console',
  browser_evaluate: 'Run JavaScript',
}

/** MCP results may arrive as content blocks; this gets their text. */
function outputText(output: string | undefined): string {
  if (!output) return ''
  const trimmed = output.trim()
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const blocks = Array.isArray(parsed)
        ? parsed
        : parsed &&
            typeof parsed === 'object' &&
            Array.isArray((parsed as { content?: unknown }).content)
          ? (parsed as { content: unknown[] }).content
          : null
      // Grok: {"type":"MCP","tool_name":…,"output":{"OkayOutput":"…"}} (or {"Error":"…"}).
      const wrapped =
        parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          ? (parsed as { output?: unknown }).output
          : undefined
      if (typeof wrapped === 'string') return outputText(wrapped)
      if (wrapped && typeof wrapped === 'object') {
        const inner = Object.values(wrapped).find((v) => typeof v === 'string')
        if (typeof inner === 'string') return outputText(inner)
        const nested = Object.values(wrapped).find((v) => v && typeof v === 'object')
        if (nested) return outputText(JSON.stringify(nested))
      }
      if (blocks) {
        const texts = blocks
          .map((b) =>
            b && typeof b === 'object' && typeof (b as { text?: unknown }).text === 'string'
              ? (b as { text: string }).text
              : '',
          )
          .filter(Boolean)
        if (texts.length) return texts.join('\n')
      }
    } catch {
      // Plain text after all.
    }
  }
  return output
}

function inputSummary(name: BrowserToolName, args: Record<string, unknown>): string {
  const verb = VERB[name]
  const s = (k: string) => (typeof args[k] === 'string' ? (args[k] as string) : undefined)
  switch (name) {
    case 'browser_navigate':
      return s('url') ? `${verb} ${s('url')}` : verb
    case 'browser_tabs':
      return `${verb}: ${s('action') ?? 'list'}${s('url') ? ` ${s('url')}` : ''}${args.tab !== undefined ? ` ${String(args.tab)}` : ''}`
    case 'browser_type':
      return `${verb} ${JSON.stringify(s('text') ?? '')}${s('ref') ? ` into ${s('ref')}` : ''}`
    case 'browser_press_key':
      return `${verb} ${s('key') ?? ''}`
    case 'browser_wait_for':
      return `${verb} ${s('text') ? JSON.stringify(s('text')) : (s('selector') ?? s('text_gone') ?? s('url') ?? '')}`.trim()
    case 'browser_scroll':
      return `${verb} ${s('direction') ?? ''}${s('ref') ? ` ${s('ref')}` : ''}`.trim()
    case 'browser_evaluate': {
      const script = s('script') ?? s('expression') ?? ''
      return script ? `${verb}: ${script.replace(/\s+/g, ' ').slice(0, 80)}` : verb
    }
    default:
      return s('ref') ? `${verb} ${s('ref')}` : verb
  }
}

/** Reads a browser tool call for its card. */
export function browserToolView(tool: Tool): BrowserToolView | undefined {
  const name = browserToolName(tool)
  if (!name) return undefined
  const given = looseJson(tool.input)
  // Grok calls them through its use_tool: { tool_name, tool_input: {…} }.
  const nestedArgs = given.tool_input ?? given.toolInput ?? given.arguments
  const args =
    nestedArgs && typeof nestedArgs === 'object' && !Array.isArray(nestedArgs)
      ? (nestedArgs as Record<string, unknown>)
      : given
  const text = outputText(tool.output)
  const lines = text.split('\n')
  let image: string | undefined
  let page: BrowserToolView['page']
  const rest: string[] = []
  for (const line of lines) {
    const img = /^image: (.+)$/.exec(line)
    if (img && !image) {
      image = img[1]!.trim()
      continue
    }
    const at = /^Page: (?:(.*) — )?(\S+)$/.exec(line)
    if (at && !page) {
      page = { title: at[1] || undefined, url: at[2]! }
      continue
    }
    rest.push(line)
  }
  const detail = rest.join('\n').trim()
  const failed = tool.status === 'failed'
  let summary = inputSummary(name, args)
  if (
    tool.status === 'ok' &&
    name !== 'browser_snapshot' &&
    name !== 'browser_console' &&
    name !== 'browser_evaluate'
  ) {
    // The answer's first line says what happened ("Clicked button "Place order".").
    const first = rest
      .find((l) => l.trim())
      ?.replace(/^Tab \d+\. /, '')
      .replace(/\.$/, '')
    if (first && first.length <= 140 && !/^Your tabs|^You have no tabs/.test(first)) summary = first
  }
  return { name, summary, page, image, detail, failed }
}
