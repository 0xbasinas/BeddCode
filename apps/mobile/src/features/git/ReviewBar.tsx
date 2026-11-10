import { formatReview, reviewPatchVersion } from '@beddcode/client-runtime'
import type { ReviewComment } from '@beddcode/client-runtime'
import { useState } from 'react'
import { Pressable, StyleSheet, View } from 'react-native'

import { useComposerPrefill } from '@/host/composerPrefill'
import { hostRequest, prompt } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Faint, Text } from '@/ui/Text'
import { useReviewStore } from './reviewStore'

const NO_COMMENTS: ReviewComment[] = []

/** Pending review notes under the changed files: send them now, or put them in the composer. */
export function ReviewBar({
  hostKey,
  cwd,
  sessionId,
  storeKey,
}: {
  hostKey: string
  cwd: string
  sessionId: string
  storeKey: string
}) {
  const comments = useReviewStore((s) => s.comments[storeKey] ?? NO_COMMENTS)
  const clearSent = useReviewStore((s) => s.clearSent)
  const [busy, setBusy] = useState<'send' | 'draft'>()
  const [error, setError] = useState<string>()
  if (comments.length === 0 && !error) return null

  const textOf = (sent: ReviewComment[], stale: boolean) =>
    (stale
      ? 'These comments include earlier diff context. Files have changed or could not be verified; check their current contents before acting.\n\n'
      : '') + formatReview({ cwd, comments: sent })

  const run = async (kind: 'send' | 'draft') => {
    const sent = [...comments]
    setBusy(kind)
    setError(undefined)
    try {
      const versions = new Map<string, string | null>()
      await Promise.all(
        [...new Set(sent.map((c) => c.path))].map(async (path) => {
          try {
            const diff = await hostRequest(hostKey, 'git.diff', { cwd, path })
            versions.set(path, diff.truncated ? null : reviewPatchVersion(diff.patch))
          } catch {
            versions.set(path, null)
          }
        }),
      )
      const stale = sent.some((c) => !c.patchVersion || versions.get(c.path) !== c.patchVersion)
      const text = textOf(sent, stale)
      if (kind === 'send') await prompt(sessionId, text)
      else useComposerPrefill.getState().set(sessionId, text)
      clearSent(storeKey, sent)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the review')
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <View style={styles.bar}>
      <Text size={13} style={{ flex: 1 }}>
        {comments.length} review note{comments.length === 1 ? '' : 's'}
      </Text>
      <Pressable onPress={() => void run('draft')} disabled={!!busy}>
        <Faint size={12.5}>{busy === 'draft' ? '…' : 'To composer'}</Faint>
      </Pressable>
      <Pressable onPress={() => void run('send')} disabled={!!busy}>
        <Text size={12.5}>{busy === 'send' ? 'Sending…' : 'Send now'}</Text>
      </Pressable>
      {error ? (
        <Text size={12} color={colors.danger} style={{ flexBasis: '100%' }}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.borderSubtle,
  },
})
