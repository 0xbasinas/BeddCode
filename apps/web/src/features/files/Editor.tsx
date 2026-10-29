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
import {
  resolveTheme,
  useAppPreferences,
  type AppPreferences,
} from '../../stores/appPreferences.ts'

const theme = EditorView.theme(
  {
    '&': { height: '100%', backgroundColor: 'transparent', color: 'var(--text-secondary)' },
    '.cm-scroller': { fontFamily: 'var(--font-mono)' },
    '.cm-content': { caretColor: 'var(--accent)' },
    '.cm-cursor': { borderLeftColor: 'var(--accent)' },
    '.cm-gutters': { backgroundColor: 'transparent', color: 'var(--text-faint)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'var(--bg-hover)' },
    '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
    '&.cm-focused': { outline: 'none' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)',
    },
    '.cm-matchingBracket': {
      backgroundColor: 'color-mix(in srgb, var(--accent) 25%, transparent)',
      outline: 'none',
    },
    '.cm-panels': { backgroundColor: 'var(--bg-raised)', color: 'var(--text)' },
    '.cm-searchMatch': { backgroundColor: 'color-mix(in srgb, var(--accent) 30%, transparent)' },
  },
  { dark: true },
)

// Syntax colours are mostly the app's grays; only strings keep a faint green tint.
const highlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: [t.keyword, t.controlKeyword, t.modifier, t.operatorKeyword], color: 'var(--text)' },
    {
      tag: [t.string, t.special(t.string), t.regexp],
      color: 'color-mix(in srgb, var(--success) 45%, var(--text-muted))',
    },
    {
      tag: [t.number, t.bool, t.null, t.atom],
      color: 'var(--text-secondary)',
    },
    {
      tag: [t.comment, t.lineComment, t.blockComment],
      color: 'var(--text-faint)',
      fontStyle: 'italic',
    },
    { tag: [t.typeName, t.className, t.namespace], color: 'var(--text-secondary)' },
    {
      tag: [
        t.function(t.variableName),
        t.function(t.propertyName),
        t.definition(t.function(t.variableName)),
      ],
      color: 'var(--text-secondary)',
    },
    { tag: [t.propertyName, t.attributeName], color: 'var(--text-muted)' },
    { tag: [t.tagName, t.heading], color: 'var(--text)', fontWeight: 'bold' },
    { tag: [t.operator, t.punctuation, t.bracket], color: 'var(--text-faint)' },
    { tag: [t.link, t.url], color: 'var(--text-secondary)', textDecoration: 'underline' },
    { tag: t.invalid, color: 'var(--danger)' },
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
  onChange(text: string): void
  onSave(text: string): void
  onCursor(position: EditorPosition): void
  /** Filled with a function that returns the text currently in the editor (for the Save button). */
  textRef: { current: (() => string) | null }
}

interface Held {
  state: EditorState
  version: number
  language: Compartment
  configuration: Compartment
}

function editorConfiguration(preferences: AppPreferences): Extension[] {
  return [
    EditorView.theme({
      '&': { fontSize: `${preferences.editorFontSize}px` },
      '.cm-scroller': { lineHeight: `${Math.round(preferences.editorFontSize * 1.65)}px` },
    }),
    EditorView.darkTheme.of(resolveTheme(preferences.theme) === 'dark'),
    EditorState.tabSize.of(preferences.editorTabSize),
    ...(preferences.editorLineNumbers ? [lineNumbers()] : []),
    ...(preferences.editorWordWrap ? [EditorView.lineWrapping] : []),
  ]
}

const COMMON: Extension[] = [
  highlightActiveLineGutter(),
  highlightActiveLine(),
  history(),
  drawSelection(),
  indentOnInput(),
  bracketMatching(),
  highlightSelectionMatches(),
  theme,
  highlight,
]

/** A CodeMirror 6 editor with one remembered state (text, cursor, undo history) per open file. */
export function Editor(props: EditorProps) {
  const preferences = useAppPreferences((s) => s.values)
  const preferencesRef = useRef(preferences)
  preferencesRef.current = preferences
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
      const configuration = new Compartment()
      const state = EditorState.create({
        doc: latest.current.content,
        extensions: [
          ...COMMON,
          language.of([]),
          configuration.of(editorConfiguration(preferencesRef.current)),
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
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
            if (update.docChanged || update.selectionSet) {
              const head = update.state.selection.main.head
              const line = update.state.doc.lineAt(head)
              latest.current.onCursor({ line: line.number, col: head - line.from + 1 })
            }
          }),
        ],
      })
      entry = { state, version: props.version, language, configuration }
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

  useEffect(() => {
    for (const [key, entry] of held.current) {
      const effects = entry.configuration.reconfigure(editorConfiguration(preferencesRef.current))
      if (current.current === key && view.current) view.current.dispatch({ effects })
      else entry.state = entry.state.update({ effects }).state
    }
  }, [
    preferences.editorFontSize,
    preferences.editorTabSize,
    preferences.editorWordWrap,
    preferences.editorLineNumbers,
  ])

  return <div className="editor-host" ref={host} />
}
