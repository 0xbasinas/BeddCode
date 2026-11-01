import { useState } from 'react'
import type { CiReport } from '@beddcode/contracts'
import { hostRequest } from '../../stores/host.ts'
import { composerDraftKey, useComposerDrafts } from '../composer/drafts.ts'
import { ciPrompt } from './ciPrompt.ts'

/** Reading CI never starts a turn. The user chooses logs and reviews the resulting prompt. */
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
  const [selected, setSelected] = useState<number[]>([])
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [stale, setStale] = useState(false)
  const [allowStale, setAllowStale] = useState(false)
  const load = async () => {
    setBusy(true)
    setNotice('')
    try {
      const next = await hostRequest(hostKey, 'git.ci.report', { cwd })
      setReport(next)
      setStale(false)
      setAllowStale(false)
      setSelected(next.failures.map((_, index) => index))
      setText(ciPrompt(next))
      if (!next.failures.length)
        setNotice('No failed checks were returned. Refresh CI before preparing a follow-up.')
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const addDraft = async () => {
    if (!report) return
    setBusy(true)
    try {
      if (!report.pr?.headOid) {
        setStale(true)
        if (!allowStale) {
          setNotice(
            'The captured PR head is unavailable. Review the run identities and explicitly accept the unverified context.',
          )
          return
        }
      } else {
        const current = await hostRequest(hostKey, 'git.pr.view', { cwd, number: report.pr.number })
        if (current.headOid !== report.pr.headOid) {
          setStale(true)
          if (!allowStale) {
            setNotice(
              `PR head changed from ${report.pr.headOid} to ${current.headOid ?? 'unknown'}. Refresh CI or explicitly keep the captured logs.`,
            )
            return
          }
        }
      }
      const drafts = useComposerDrafts.getState()
      const key = composerDraftKey(hostKey, sessionId)
      drafts.setDraft(
        key,
        [
          drafts.drafts[key],
          stale
            ? 'Warning: CI context is stale or its PR head could not be verified.\n\n' + text
            : text,
        ]
          .filter(Boolean)
          .join('\n\n'),
      )
      setReport(undefined)
      setNotice('Added to the session draft. Review it in the message box, then send when ready.')
    } catch (err) {
      setNotice(
        `Could not verify the current PR head: ${err instanceof Error ? err.message : String(err)}. Your prepared message is preserved.`,
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="ci-follow-up">
      <button disabled={busy} onClick={() => void load()}>
        {busy ? 'Reading CI…' : 'Prepare CI follow-up'}
      </button>
      {report && (
        <div>
          <p className="muted">
            Logs describe the recorded run commits below. They may differ from the current checkout.
            Review before sending.
          </p>
          {report.failures.map((failure, index) => (
            <label key={index} style={{ display: 'block' }}>
              <input
                type="checkbox"
                checked={selected.includes(index)}
                onChange={(event) => {
                  const selection = event.target.checked
                    ? [...selected, index]
                    : selected.filter((i) => i !== index)
                  setSelected(selection)
                  setText(
                    ciPrompt({
                      ...report,
                      failures: report.failures.filter((_, i) => selection.includes(i)),
                    }),
                  )
                }}
              />{' '}
              {failure.checks.join(', ')}
            </label>
          ))}
          <textarea
            aria-label="CI follow-up"
            value={text}
            onChange={(event) => setText(event.target.value)}
            style={{ width: '100%', minHeight: 180 }}
          />
          <button
            disabled={busy || !selected.length || !text.trim()}
            onClick={() => void addDraft()}
          >
            Add to message draft
          </button>
          {stale && (
            <label>
              <input
                type="checkbox"
                checked={allowStale}
                onChange={(event) => setAllowStale(event.target.checked)}
              />{' '}
              Keep captured logs despite stale or unverified PR head
            </label>
          )}
          <button onClick={() => setReport(undefined)}>Close CI follow-up</button>
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  )
}
