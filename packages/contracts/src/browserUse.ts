import { z } from 'zod'

// Browser use: an agent drives the desktop app's browser pane. The host gives the agent MCP tools
// (browser_*), sends each call to a connected desktop app over its WebSocket, and that app runs it
// on a tab of its own (see apps/desktop/src/browserAgent.ts).

/** The tools, in the order agents see them. */
export const BROWSER_TOOL_NAMES = [
  'browser_tabs',
  'browser_navigate',
  'browser_back',
  'browser_forward',
  'browser_reload',
  'browser_snapshot',
  'browser_click',
  'browser_type',
  'browser_press_key',
  'browser_hover',
  'browser_select_option',
  'browser_scroll',
  'browser_wait_for',
  'browser_screenshot',
  'browser_console',
  'browser_evaluate',
] as const
export type BrowserToolName = (typeof BROWSER_TOOL_NAMES)[number]

export const isBrowserToolName = (name: string): name is BrowserToolName =>
  (BROWSER_TOOL_NAMES as readonly string[]).includes(name)

/** One tool call, as the host sends it to the desktop app that runs it. */
export const BrowserUseCall = z.object({
  sessionId: z.string(),
  tool: z.enum(BROWSER_TOOL_NAMES),
  args: z.record(z.string(), z.unknown()),
  /** Who is driving, for the pane's "Claude is using this tab". */
  agent: z.string(),
  sessionTitle: z.string().optional(),
  /** Ask before an action that submits a form on a page outside this machine. */
  confirmSubmits: z.boolean().optional(),
  /** The user already allowed this call (after a `needsApproval` answer). */
  approved: z.boolean().optional(),
})
export type BrowserUseCall = z.infer<typeof BrowserUseCall>

const Image = z.object({ data: z.string(), mime: z.enum(['image/png', 'image/jpeg']) })

/** What the desktop app answers. */
export const BrowserUseResult = z.union([
  z.object({
    ok: z.literal(true),
    /** What the agent reads. */
    text: z.string(),
    /** An image the agent sees too (browser_screenshot). */
    image: Image.optional(),
    /** A small picture of the page after the action, for the conversation's tool card. */
    thumb: Image.optional(),
  }),
  /** The action needs the user's yes first; the host asks and calls again with `approved`. */
  z.object({
    ok: z.literal(false),
    needsApproval: z.object({ title: z.string(), detail: z.string().optional() }),
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type BrowserUseResult = z.infer<typeof BrowserUseResult>

/** Why a client cannot run browser tools, when it says so. */
export const BrowserUnavailable = z.enum(['web', 'mobile'])
export type BrowserUnavailable = z.infer<typeof BrowserUnavailable>
