import type { BrowserAgentAction, BrowserUseCall, BrowserUseResult } from '@beddcode/contracts'
import { setBrowserCallHandler } from '../../stores/host.ts'
import {
  agentKey,
  browserCommand,
  nativeBrowser,
  useBrowser,
  type BrowserTab,
  type BrowserTabAgent,
} from './browserStore.ts'
import { loopbackPort, previewTarget } from './preview.ts'

// Browser use, the app page's part: an agent's browser_* tool call arrives from its host (see
// apps/server/src/automation/browserUse.ts). Here the tab is chosen (the agent's own tabs; a tab
// of the user's only once they agree), the user can pause it, and the action itself goes to the
// main process (apps/desktop/src/browserAgent.ts).

const fail = (error: string): BrowserUseResult => ({ ok: false, error })

const tabLine = (tab: BrowserTab, current: boolean) =>
  `Tab ${tab.id}${current ? ' (current)' : ''}: ${tab.title && tab.title !== tab.url ? `${tab.title} — ` : ''}${shownUrl(tab, tab.url)}`

/** Addresses as the agent knows them: a forwarded remote port shows as the host's own port. */
function shownUrl(tab: BrowserTab | undefined, text: string): string {
  const local = tab?.agent?.localPort
  const remote = tab?.via?.port
  if (!local || !remote) return text
  return text.replace(
    new RegExp(`(localhost|127\\.0\\.0\\.1):${local}(?!\\d)`, 'g'),
    (_m, host: string) => `${host}:${remote}`,
  )
}

function ownTabs(key: string): BrowserTab[] {
  return useBrowser
    .getState()
    .tabs.filter((t) => t.agent && agentKey(t.agent.hostKey, t.agent.sessionId) === key)
}

function setCurrent(key: string, tabId: number) {
  useBrowser.setState((s) => ({ agentTab: { ...s.agentTab, [key]: tabId } }))
}

function listTabs(key: string): string {
  const { tabs, agentTab } = useBrowser.getState()
  const mine = ownTabs(key)
  const theirs = tabs.filter((t) => !t.agent)
  const lines: string[] = []
  lines.push(
    mine.length
      ? `Your tabs:\n${mine.map((t) => tabLine(t, agentTab[key] === t.id)).join('\n')}`
      : 'You have no tabs yet. Open one with browser_navigate or browser_tabs {"action":"open"}.',
  )
  if (theirs.length)
    lines.push(
      `The user's tabs (selecting one asks the user to let you use it):\n${theirs.map((t) => tabLine(t, false)).join('\n')}`,
    )
  return lines.join('\n\n')
}

/** Where an agent's address goes: on a remote host, localhost is that host's machine. */
async function target(hostKey: string, url: string) {
  if (!/^https?:\/\//i.test(url)) {
    if (/^[\w.-]+(:\d+)?(\/|$)/.test(url))
      url = `${/^(localhost|127\.|\[::1\])/.test(url) ? 'http' : 'https'}://${url}`
    else throw new Error('Only http:// and https:// addresses can be opened.')
  }
  const t = await previewTarget(hostKey, url)
  return { ...t, localPort: t.via ? (loopbackPort(t.url) ?? undefined) : undefined }
}

/** Opens a new tab of the agent's, out of the user's way, and makes it the current one. */
async function openTab(hostKey: string, call: BrowserUseCall, key: string): Promise<number> {
  const agent: BrowserTabAgent = {
    hostKey,
    sessionId: call.sessionId,
    label: call.agent,
    sessionTitle: call.sessionTitle,
  }
  const id = useBrowser.getState().open('about:blank', { newTab: true, background: true, agent })
  await browserCommand({ op: 'ensure', tabId: id, url: 'about:blank' })
  await browserCommand({ op: 'agent-control', tabId: id, agent: call.agent })
  setCurrent(key, id)
  return id
}

async function act(
  tab: BrowserTab,
  call: BrowserUseCall,
  args: Record<string, unknown> = call.args,
): Promise<BrowserUseResult> {
  const action: BrowserAgentAction = {
    tool: call.tool,
    args,
    agent: call.agent,
    confirmSubmits: call.confirmSubmits,
    approved: call.approved,
  }
  // A discarded page comes back first; it renders for the agent while hidden.
  await browserCommand({ op: 'ensure', tabId: tab.id, url: tab.url })
  await browserCommand({ op: 'agent-control', tabId: tab.id, agent: call.agent })
  const result = await browserCommand<BrowserUseResult>({ op: 'agent', tabId: tab.id, action })
  if (!result) return fail('The desktop app did not answer. Try again.')
  if (!result.ok) return 'error' in result ? fail(shownUrl(tab, result.error)) : result
  return { ...result, text: shownUrl(tab, `Tab ${tab.id}. ${result.text}`) }
}

/** Runs one browser tool call from an agent of `hostKey`. */
export async function runBrowserCall(
  hostKey: string,
  call: BrowserUseCall,
): Promise<BrowserUseResult> {
  if (!nativeBrowser())
    return fail('Browser tools need the BeddCode desktop app; this is the web version.')
  const key = agentKey(hostKey, call.sessionId)
  const state = useBrowser.getState()
  if (state.paused[key])
    return fail(
      'The user has taken over the browser. Stop using browser tools and ask the user how to continue; they can hand it back in the browser pane.',
    )
  const note = state.agentNotes[key]
  if (note)
    useBrowser.setState((s) => {
      const { [key]: _gone, ...agentNotes } = s.agentNotes
      return { agentNotes }
    })
  const result = await dispatch(hostKey, call, key)
  if (note && result.ok) return { ...result, text: `${note}\n${result.text}` }
  return result
}

async function dispatch(
  hostKey: string,
  call: BrowserUseCall,
  key: string,
): Promise<BrowserUseResult> {
  const a = call.args
  const tabArg =
    typeof a.tab === 'number' ? a.tab : typeof a.tab === 'string' ? Number(a.tab) : undefined
  const find = (id: number | undefined) =>
    id === undefined ? undefined : useBrowser.getState().tabs.find((t) => t.id === id)
  const current = () => {
    const { agentTab } = useBrowser.getState()
    const tab = find(agentTab[key])
    return tab?.agent && agentKey(tab.agent.hostKey, tab.agent.sessionId) === key ? tab : undefined
  }

  switch (call.tool) {
    case 'browser_tabs': {
      const action = typeof a.action === 'string' ? a.action : 'list'
      if (action === 'list') return { ok: true, text: listTabs(key) }
      if (action === 'open') {
        const id = await openTab(hostKey, call, key)
        const url = typeof a.url === 'string' && a.url ? a.url : undefined
        if (!url) return { ok: true, text: `Opened Tab ${id}, now your current tab.` }
        return navigate(hostKey, find(id)!, call, url)
      }
      const tab = find(tabArg)
      if (!tab) return fail(`There is no Tab ${a.tab ?? ''}.\n\n${listTabs(key)}`)
      const mine = tab.agent && agentKey(tab.agent.hostKey, tab.agent.sessionId) === key
      if (action === 'select') {
        if (!mine) {
          if (tab.agent) return fail(`Tab ${tab.id} belongs to another agent session.`)
          if (!call.approved)
            return {
              ok: false,
              needsApproval: {
                title: `Let ${call.agent} use your tab "${tab.title || tab.url}"?`,
                detail: tab.url,
              },
            }
          useBrowser.setState((s) => ({
            tabs: s.tabs.map((t) =>
              t.id === tab.id
                ? {
                    ...t,
                    agent: {
                      hostKey,
                      sessionId: call.sessionId,
                      label: call.agent,
                      sessionTitle: call.sessionTitle,
                    },
                  }
                : t,
            ),
          }))
          await browserCommand({ op: 'agent-control', tabId: tab.id, agent: call.agent })
        }
        setCurrent(key, tab.id)
        return {
          ok: true,
          text: `Tab ${tab.id} is now your current tab.\n${tabLine(find(tab.id)!, true)}`,
        }
      }
      if (action === 'close') {
        if (!mine)
          return fail(`Tab ${tab.id} is not one of yours; only your own tabs can be closed.`)
        useBrowser.getState().close(tab.id)
        return { ok: true, text: `Closed Tab ${tab.id}.\n\n${listTabs(key)}` }
      }
      return fail('action is one of list, open, select, close.')
    }
    case 'browser_navigate': {
      const url = typeof a.url === 'string' ? a.url.trim() : ''
      if (!url) return fail('Give the address to open.')
      const asked = find(tabArg)
      if (
        tabArg !== undefined &&
        (!asked?.agent || agentKey(asked.agent.hostKey, asked.agent.sessionId) !== key)
      )
        return fail(`Tab ${tabArg} is not one of yours. Select it with browser_tabs first.`)
      const tab = asked ?? current() ?? find(await openTab(hostKey, call, key))!
      setCurrent(key, tab.id)
      return navigate(hostKey, tab, call, url)
    }
  }
  const tab = tabArg !== undefined ? find(tabArg) : current()
  if (tabArg !== undefined) {
    if (!tab) return fail(`There is no Tab ${tabArg}.\n\n${listTabs(key)}`)
    if (!tab.agent || agentKey(tab.agent.hostKey, tab.agent.sessionId) !== key)
      return fail(
        `Tab ${tabArg} is not one of yours. Select it with browser_tabs first (the user is asked).`,
      )
    setCurrent(key, tab.id)
  }
  if (!tab)
    return fail(
      'You have no browser tab open. Open a page with browser_navigate first (or browser_tabs to see the tabs).',
    )
  return act(tab, call)
}

async function navigate(
  hostKey: string,
  tab: BrowserTab,
  call: BrowserUseCall,
  url: string,
): Promise<BrowserUseResult> {
  let t: Awaited<ReturnType<typeof target>>
  try {
    t = await target(hostKey, url)
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err))
  }
  useBrowser.setState((s) => ({
    tabs: s.tabs.map((x) =>
      x.id === tab.id
        ? { ...x, via: t.via, agent: x.agent && { ...x.agent, localPort: t.localPort } }
        : x,
    ),
  }))
  const updated = useBrowser.getState().tabs.find((x) => x.id === tab.id) ?? tab
  return act(updated, { ...call, tool: 'browser_navigate' }, { url: t.url })
}

setBrowserCallHandler(runBrowserCall)
