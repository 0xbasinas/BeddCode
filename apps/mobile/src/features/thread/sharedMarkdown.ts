import {
  AstRenderer,
  createMarkdownIt,
  removeTextStyleProps,
  renderRules,
  styles as libraryStyles,
  type MarkdownStyleMap,
  type MarkdownStyleObject,
} from '@ronradtke/react-native-markdown-display'
import { StyleSheet, Text } from 'react-native'

const IMAGES = [
  'data:image/png;base64',
  'data:image/gif;base64',
  'data:image/jpeg;base64',
  'https://',
  'http://',
]

/**
 * The props that make every `<Markdown>` share one parser and one renderer.
 *
 * Left to itself the library builds a new markdown-it parser, a new renderer and a merged copy of
 * all its styles for every message it draws (its defaults are fresh objects on each render), which
 * is most of the time a thread takes to open. The styles are merged here the way the library does
 * it, once.
 */
export function sharedMarkdown(style: MarkdownStyleMap) {
  const merged: Record<string, MarkdownStyleObject> = {}
  for (const name of Object.keys(style)) {
    merged[name] = { ...StyleSheet.flatten(style[name]) }
  }
  for (const name of Object.keys(libraryStyles)) {
    merged[name] = { ...libraryStyles[name], ...StyleSheet.flatten(style[name]) }
  }
  for (const name of Object.keys(merged)) {
    merged[`_VIEW_SAFE_${name}`] = removeTextStyleProps(merged[name] ?? {})
  }
  return {
    markdownit: createMarkdownIt(),
    renderer: new AstRenderer(
      renderRules(Text),
      StyleSheet.create(merged),
      undefined,
      null,
      null,
      IMAGES,
      'https://',
      false,
    ),
  }
}
