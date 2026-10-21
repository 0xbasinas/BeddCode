import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import {
  LanguageDescription,
  HighlightStyle,
  syntaxHighlighting,
  bracketMatching,
  indentOnInput,
} from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, type Extension } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view'
import { tags as t } from '@lezer/highlight'

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: '#ececec', fontSize: '13px' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.65' },
    '.cm-content': { caretColor: '#f0a43c' },
    '.cm-cursor': { borderLeftColor: '#f0a43c' },
    '.cm-gutters': { backgroundColor: 'transparent', color: '#5c5c5c', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.04)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: '#8a8a8a' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(240, 164, 60, 0.25)',
    },
    '.cm-matchingBracket': { backgroundColor: 'rgba(240, 164, 60, 0.25)', outline: 'none' },
    '.cm-panels': { backgroundColor: '#1f1f1f', color: '#ececec' },
    '.cm-searchMatch': { backgroundColor: 'rgba(240, 164, 60, 0.3)' },
  },
  { dark: true },
)

const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.modifier, t.operatorKeyword], color: '#c792ea' },
    { tag: [t.string, t.special(t.string), t.regexp], color: '#a5d6a7' },
    { tag: [t.number, t.bool, t.null, t.atom], color: '#ffab70' },
    { tag: [t.comment, t.lineComment, t.blockComment], color: '#6b6b6b', fontStyle: 'italic' },
    { tag: [t.typeName, t.className, t.namespace], color: '#82aaff' },
    {
      tag: [
        t.function(t.variableName),
        t.function(t.propertyName),
        t.definition(t.function(t.variableName)),
      ],
      color: '#82b1ff',
    },
    { tag: [t.propertyName, t.attributeName], color: '#e0e0e0' },
    { tag: [t.tagName, t.heading], color: '#f07178', fontWeight: 'bold' },
    { tag: [t.operator, t.punctuation, t.bracket], color: '#9a9a9a' },
    { tag: [t.link, t.url], color: '#82aaff', textDecoration: 'underline' },
    { tag: t.invalid, color: '#e5645c' },
  ]),
)

export interface EditorPosition {
  line: number
  col: number
}

interface EditorProps {
  /** Identifies the document; its undo history is kept while another tab is shown. */
  docKey: string
  fileName: string
  content: string
  /** Bumped when `content` was replaced from disk: the editor starts over from it. */
  version: number
  onDirty(dirty: boolean): void
  onSave(text: string): void
  onCursor(position: EditorPosition): void
  /** Filled with a function that returns the text currently in the editor (for the Save button). */
  textRef: { current: (() => string) | null }
}

interface Held {
  state: EditorState
  version: number
  language: Compartment
}

const COMMON: Extension[] = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightActiveLine(),
  history(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  highlightSelectionMatches(),
  EditorState.tabSize.of(2),
  theme,
  highlight,
]

/** A CodeMirror 6 editor with one remembered state (text, cursor, undo history) per open file. */
export function Editor(props: EditorProps) {
  const host = useRef<HTMLDivElement>(null)
  const view = useRef<EditorView | null>(null)
  const held = useRef(new Map<string, Held>())
  const current = useRef<string | null>(null)
  const shown = useRef<{ key: string; version: number } | null>(null)
  const latest = useRef(props)
  latest.current = props

  // One view for the lifetime of the component.
  useEffect(() => {
    const el = host.current
    if (!el) return
    const v = new EditorView({ parent: el, state: EditorState.create({ doc: '' }) })
    view.current = v
    latest.current.textRef.current = () => v.state.doc.toString()
    const states = held.current
    return () => {
      v.destroy()
      view.current = null
      states.clear()
      current.current = null
      shown.current = null
    }
  }, [])

  // Show the requested document, building its state the first time (or after a reload from disk).
  useEffect(() => {
    const v = view.current
    if (!v) return
    // Already showing this document: the view holds the live text, so leave it alone.
    if (shown.current?.key === props.docKey && shown.current.version === props.version) return
    // Keep what the user did to the file we are leaving.
    if (current.current && current.current !== props.docKey) {
      const prev = held.current.get(current.current)
      if (prev) prev.state = v.state
    }

    let entry = held.current.get(props.docKey)
    if (!entry || entry.version !== props.version) {
      const language = new Compartment()
      const state = EditorState.create({
        doc: latest.current.content,
        extensions: [
          ...COMMON,
          language.of([]),
          keymap.of([
            {
              key: 'Mod-s',
              preventDefault: true,
              run: (view) => {
                latest.current.onSave(view.state.doc.toString())
                return true
              },
            },
            indentWithTab,
            ...searchKeymap,
            ...historyKeymap,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onDirty(true)
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head
              const line = update.state.doc.lineAt(head)
              latest.current.onCursor({ line: line.number, col: head - line.from + 1 })
            }
          }),
        ],
      })
      entry = { state, version: props.version, language }
      held.current.set(props.docKey, entry)

      // Syntax highlighting loads on demand, per language.
      const description = LanguageDescription.matchFilename(languages, props.fileName)
      if (description) {
        const key = props.docKey
        void description.load().then((support) => {
          if (current.current === key) {
            v.dispatch({ effects: language.reconfigure(support) })
          } else {
            // Not on screen right now: apply it to the stored state for later.
            const stored = held.current.get(key)
            if (stored) {
              stored.state = stored.state.update({ effects: language.reconfigure(support) }).state
            }
          }
        })
      }
    }

    current.current = props.docKey
    shown.current = { key: props.docKey, version: props.version }
    v.setState(entry.state)
    const head = entry.state.selection.main.head
    const line = entry.state.doc.lineAt(head)
    latest.current.onCursor({ line: line.number, col: head - line.from + 1 })
    v.focus()
  }, [props.docKey, props.version, props.fileName])

  return <div className="editor-host" ref={host} />
}
