import type { CiReport } from '@beddcode/contracts'
import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native'

import { useComposerPrefill } from '@/host/composerPrefill'
import { hostRequest } from '@/host/store'
import { colors, radius } from '@/theme/tokens'
import { Faint, Muted, Text } from '@/ui/Text'
import { ciPrompt } from './ciPrompt'

/** Load failing CI and put a follow-up prompt in the thread composer, without starting a turn yet. */
export function CiFollowUp({
  hostKey,
  cwd,
  sessionId,
}: {
  hostKey: string
  cwd: string
  sessionId: string
}) {
  const [report, setReport] = useState<CiReport>()
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()

  const load = async () => {
    setBusy(true)
    setNotice(undefined)
    setError(undefined)
    try {
      const next = await hostRequest(hostKey, 'git.ci.report', { cwd })
      setReport(next)
      if (!next.failures.length) setNotice('No failed checks were returned.')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const sendToComposer = () => {
    if (!report) return
    useComposerPrefill.getState().set(sessionId, ciPrompt(report))
    setNotice('Added to the composer. Open the thread to review and send it.')
  }

  return (
    <View style={styles.box}>
      <View style={styles.row}>
        <Text size={13.5} style={{ flex: 1 }}>
          CI follow-up
        </Text>
        <Pressable onPress={() => void load()} disabled={busy} accessibilityRole="button">
          {busy ? (
            <ActivityIndicator size="small" color={colors.muted} />
          ) : (
            <Muted size={12.5}>{report ? 'Refresh' : 'Load failing checks'}</Muted>
          )}
        </Pressable>
      </View>
      {report ? (
        <Faint size={12}>
          {report.failures.length} failed · {report.runs.length} recent runs
          {report.branch ? ` on ${report.branch}` : ''}
        </Faint>
      ) : null}
      {report && report.failures.length > 0 ? (
        <Pressable style={styles.btn} onPress={sendToComposer} accessibilityRole="button">
          <Text size={13}>Put a follow-up in the composer</Text>
        </Pressable>
      ) : null}
      {notice ? <Muted size={12}>{notice}</Muted> : null}
      {error ? (
        <Text size={12} color={colors.danger}>
          {error}
        </Text>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    marginHorizontal: 12,
    marginBottom: 10,
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.card,
    borderRadius: radius.panel,
    padding: 12,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  btn: {
    alignSelf: 'flex-start',
    backgroundColor: colors.hover,
    borderRadius: radius.control,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
})
