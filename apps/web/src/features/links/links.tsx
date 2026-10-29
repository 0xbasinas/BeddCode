import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  type MouseEvent,
  type ReactNode,
} from 'react'
import { findTextLinks, pathFromHref } from '@beddcode/client-runtime'
import { useUiStore } from '../../stores/ui.ts'
import { useBrowser } from '../browser/browserStore.ts'
import { folderId, useFiles } from '../files/filesStore.ts'
import { openInEditor, useEditorStore, useEditors } from '../editors/editors.ts'
import { linkKey, locate, useLinkStore, type Located } from './linkStore.ts'

/** The session folder paths in text are read against; without one they stay plain text. */
export interface LinkScopeValue {
  hostKey: string
  cwd: string
}

const LinkScopeContext = createContext<LinkScopeValue | null>(null)

export function LinkScope({ value, children }: { value: LinkScopeValue; children: ReactNode }) {
  // Loads the host's editors, so a path click knows whether it can open one.
  useEditors(value.hostKey)
  return <LinkScopeContext.Provider value={value}>{children}</LinkScopeContext.Provider>
}

export const useLinkScope = () => useContext(LinkScopeContext)

/** A click that asks for the outside browser: Ctrl/⌘, Shift, or the middle button. */
const wantsOutside = (e: MouseEvent | globalThis.MouseEvent) =>
  e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1

/** Opens an address in the app's browser pane, or the system browser for a modified click. */
export function openUrl(url: string, outside = false) {
  if (outside || !/^https?:/i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer')
    return
  }
  useUiStore.getState().openPane('browser')
  useBrowser.getState().open(url, { newTab: true })
}

/**
 * Opens a path from the session folder: in the editor picked last (when the host can start one),
 * else, or with Alt held, in the Files pane at that line.
 */
export async function openLocated(
  scope: LinkScopeValue,
  found: Located,
  at: { line?: number; column?: number },
  inFilesPane = false,
) {
  const files = useFiles.getState()
  const id = folderId(scope.hostKey, scope.cwd)
  const showInPane = () => {
    useUiStore.getState().openPane('files')
    if (found.type === 'dir') void files.revealDir(id, found.path)
    else void files.openAt(id, found.path, at.line, at.column)
  }
  const editor = preferredEditor(scope.hostKey)
  if (inFilesPane || !editor) return showInPane()
  try {
    await openInEditor(scope.hostKey, editor, {
      cwd: scope.cwd,
      ...(found.path === '.' ? {} : { path: found.path }),
      ...(found.type === 'file' && at.line ? { line: at.line } : {}),
      ...(found.type === 'file' && at.line && at.column ? { column: at.column } : {}),
    })
  } catch {
    showInPane()
  }
}

/** The editor a path click opens, or undefined when the host cannot start one for us. */
function preferredEditor(hostKey: string): string | undefined {
  const { byHost, preferred } = useEditorStore.getState()
  const known = byHost[hostKey]
  if (!known?.canOpen || !known.editors.length) return undefined
  return known.editors.some((e) => e.id === preferred) ? preferred : known.editors[0]!.id
}

/** What a path link says it does, for its tooltip. */
function pathTitle(hostKey: string, found: Located, line?: number) {
  const where = `${found.path}${line ? `:${line}` : ''}`
  const editor = preferredEditor(hostKey)
  const name =
    editor && useEditorStore.getState().byHost[hostKey]?.editors.find((e) => e.id === editor)
  return name
    ? `Open ${where} in ${name.label} · Alt-click for the Files pane`
    : `Show ${where} in the Files pane`
}

/** A path that is a link once the host confirms it names something in the session folder. */
export function PathAnchor({
  path,
  line,
  column,
  children,
}: {
  path: string
  line?: number
  column?: number
  children: ReactNode
}) {
  const scope = useLinkScope()
  const key = scope ? linkKey(scope.hostKey, scope.cwd, path) : ''
  const found = useLinkStore((s) => (key ? s.found[key] : undefined))
  useEffect(() => {
    if (scope) locate(scope.hostKey, scope.cwd, path)
  }, [scope, path])
  if (!scope || !found) return <>{children}</>
  return (
    <a
      href="#"
      className="path-link"
      data-path={found.path}
      title={pathTitle(scope.hostKey, found, line)}
      onClick={(e) => {
        e.preventDefault()
        void openLocated(scope, found, { line, column }, e.altKey)
      }}
    >
      {children}
    </a>
  )
}

/** A web address: the browser pane on a click, the system browser with Ctrl/⌘ or Shift. */
export function UrlAnchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="url-link"
      title={`${href}\nCtrl/⌘-click to open in your browser`}
      onClick={(e) => {
        e.preventDefault()
        openUrl(href, wantsOutside(e))
      }}
      onAuxClick={(e) => {
        if (e.button !== 1) return
        e.preventDefault()
        openUrl(href, true)
      }}
    >
      {children}
    </a>
  )
}

/** The `a` renderer for Markdown: path markers and relative targets are paths, the rest web links. */
export function MarkdownAnchor(props: {
  href?: string
  children?: ReactNode
  'data-bdc-path'?: string
  'data-bdc-line'?: string | number
  'data-bdc-column'?: string | number
}) {
  const marked = props['data-bdc-path']
  if (marked !== undefined) {
    return (
      <PathAnchor
        path={marked}
        line={toNumber(props['data-bdc-line'])}
        column={toNumber(props['data-bdc-column'])}
      >
        {props.children}
      </PathAnchor>
    )
  }
  const href = props.href ?? ''
  const asPath = pathFromHref(href)
  if (asPath) {
    return (
      <PathAnchor path={asPath.path} line={asPath.line} column={asPath.column}>
        {props.children}
      </PathAnchor>
    )
  }
  if (!href) return <>{props.children}</>
  return <UrlAnchor href={href}>{props.children}</UrlAnchor>
}

const toNumber = (v: string | number | undefined) => {
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export { wantsOutside }

/** Past this, tool output is shown as plain text: scanning it is not worth the wait. */
const LINKED_TEXT_LIMIT = 40_000
const LINKS_PER_TEXT = 200

/** Plain text (tool output) with its web addresses and folder paths clickable. */
export function LinkedText({ text }: { text: string }) {
  const scope = useLinkScope()
  const parts = useMemo(() => {
    if (text.length > LINKED_TEXT_LIMIT) return [text]
    const links = findTextLinks(text).slice(0, LINKS_PER_TEXT)
    if (!links.length) return [text]
    const out: ReactNode[] = []
    let at = 0
    links.forEach((link, i) => {
      if (link.start > at) out.push(text.slice(at, link.start))
      out.push(
        link.kind === 'url' ? (
          <UrlAnchor key={i} href={link.url}>
            {link.text}
          </UrlAnchor>
        ) : scope ? (
          <PathAnchor key={i} path={link.path} line={link.line} column={link.column}>
            {link.text}
          </PathAnchor>
        ) : (
          link.text
        ),
      )
      at = link.end
    })
    if (at < text.length) out.push(text.slice(at))
    return out
  }, [text, scope])
  return <>{parts}</>
}
