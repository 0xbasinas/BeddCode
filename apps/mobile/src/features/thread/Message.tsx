import { memo } from 'react'
import { Linking } from 'react-native'
import { EnrichedMarkdownText, type MarkdownStyle } from 'react-native-enriched-markdown'

import { colors, fonts, radius } from '@/theme/tokens'

// Drawn by the platform's own text engine, so a message is a few native views instead of a tree of
// React ones. Defined once: the same object every time keeps messages from being redrawn.
const body = { fontFamily: fonts.regular, fontSize: 14.5, lineHeight: 22, color: colors.text }

const style: MarkdownStyle = {
  paragraph: { ...body, marginTop: 0, marginBottom: 10 },
  h1: { ...body, fontFamily: fonts.semibold, fontSize: 18, marginTop: 0, marginBottom: 8 },
  h2: { ...body, fontFamily: fonts.semibold, fontSize: 16, marginTop: 0, marginBottom: 6 },
  h3: { ...body, fontFamily: fonts.semibold, fontSize: 15, marginTop: 0, marginBottom: 4 },
  h4: { ...body, fontFamily: fonts.semibold, fontSize: 14.5, marginTop: 0, marginBottom: 4 },
  h5: { ...body, fontFamily: fonts.semibold, fontSize: 14.5, marginTop: 0, marginBottom: 4 },
  h6: { ...body, fontFamily: fonts.semibold, fontSize: 14.5, marginTop: 0, marginBottom: 4 },
  strong: { fontFamily: fonts.semibold, fontWeight: 'normal' },
  link: { color: colors.info, underline: true },
  code: {
    fontFamily: fonts.mono,
    fontSize: 12.5,
    color: colors.text,
    backgroundColor: colors.hover,
  },
  codeBlock: {
    ...body,
    fontFamily: fonts.mono,
    fontSize: 12,
    lineHeight: 18,
    color: colors.textSecondary,
    backgroundColor: colors.code,
    borderColor: colors.borderSubtle,
    borderWidth: 1,
    borderRadius: radius.control,
    padding: 10,
    marginTop: 0,
    marginBottom: 10,
  },
  list: {
    ...body,
    marginTop: 0,
    marginBottom: 6,
    bulletColor: colors.muted,
    markerColor: colors.muted,
    gapWidth: 8,
  },
  blockquote: {
    ...body,
    color: colors.textSecondary,
    borderColor: colors.border,
    borderWidth: 3,
    gapWidth: 10,
    marginTop: 0,
    marginBottom: 6,
  },
  table: {
    ...body,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 0,
    marginBottom: 10,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.control,
    headerBackgroundColor: colors.hover,
    headerTextColor: colors.text,
    headerFontFamily: fonts.semibold,
    rowEvenBackgroundColor: 'transparent',
    rowOddBackgroundColor: colors.hover,
    cellPaddingHorizontal: 10,
    cellPaddingVertical: 6,
  },
}

const open = ({ url }: { url: string }) => void Linking.openURL(url).catch(() => {})

/** One agent message, as markdown. `live` is the message still being written: new text fades in. */
export const Message = memo(function Message({ text, live }: { text: string; live?: boolean }) {
  return (
    <EnrichedMarkdownText
      markdown={text}
      markdownStyle={style}
      flavor="github"
      onLinkPress={open}
      streamingAnimation={live}
    />
  )
})
