import { useState } from 'react'
import { CircleHelp, CirclePause, Check } from 'lucide-react'
import type { TranscriptItem } from '@beddcode/client-runtime'

type QuestionItem = Extract<TranscriptItem, { kind: 'question' }>

/** What the user has chosen or typed so far, by question id. */
interface Draft {
  picked: string[]
  other: string
}

/** One answer list per question, or null while some question has no answer yet. */
export function collectAnswers(
  item: Pick<QuestionItem, 'questions'>,
  drafts: Record<string, Draft>,
): Record<string, string[]> | null {
  const answers: Record<string, string[]> = {}
  for (const q of item.questions) {
    const draft = drafts[q.id]
    const typed = draft?.other.trim()
    const values = [...(draft?.picked ?? []), ...(typed ? [typed] : [])]
    if (values.length === 0) return null
    answers[q.id] = values
  }
  return answers
}

/** A question from the agent: pick an option, type an answer, or dismiss it. */
export function QuestionCard({
  item,
  onAnswer,
}: {
  item: QuestionItem
  onAnswer(requestId: string, answers?: Record<string, string[]>): void | Promise<void>
}) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const open = !item.answers && !item.dismissed

  const patch = (id: string, change: (d: Draft) => Draft) =>
    setDrafts((all) => ({ ...all, [id]: change(all[id] ?? { picked: [], other: '' }) }))
  const answers = collectAnswers(item, drafts)

  const submit = async (value: Record<string, string[]> | undefined) => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    try {
      await onAnswer(item.requestId, value)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={`approval question ${open ? 'pending' : item.dismissed ? 'cancelled' : 'allowed'}`}
    >
      <div className="approval-state">
        {open ? (
          <CircleHelp size={15} />
        ) : item.dismissed ? (
          <CirclePause size={15} />
        ) : (
          <Check size={15} />
        )}
        {open ? 'The agent has a question' : item.dismissed ? 'Question dismissed' : 'Answered'}
      </div>

      {item.questions.map((q) => {
        const draft = drafts[q.id] ?? { picked: [], other: '' }
        const answered = item.answers?.[q.id]
        return (
          <div className="question-block" key={q.id}>
            {q.header && <div className="question-header">{q.header}</div>}
            <div className="approval-title">{q.question}</div>
            {open && q.options && (
              <div className="question-options" role={q.multiSelect ? 'group' : 'radiogroup'}>
                {q.options.map((o) => {
                  const on = draft.picked.includes(o.label)
                  return (
                    <button
                      key={o.label}
                      type="button"
                      role={q.multiSelect ? 'checkbox' : 'radio'}
                      aria-checked={on}
                      className={`question-option ${on ? 'on' : ''}`}
                      disabled={busy}
                      onClick={() =>
                        patch(q.id, (d) => ({
                          ...d,
                          picked: q.multiSelect
                            ? on
                              ? d.picked.filter((p) => p !== o.label)
                              : [...d.picked, o.label]
                            : [o.label],
                          // Choosing an option replaces a typed answer for a single choice.
                          other: q.multiSelect ? d.other : '',
                        }))
                      }
                    >
                      <span className="question-option-label">{o.label}</span>
                      {o.description && <span className="muted">{o.description}</span>}
                    </button>
                  )
                })}
              </div>
            )}
            {open && (q.allowOther || !q.options) && (
              <input
                className="path-input"
                type={q.secret ? 'password' : 'text'}
                placeholder={q.options ? 'Something else…' : 'Type your answer'}
                aria-label={q.options ? `Other answer for ${q.question}` : q.question}
                value={draft.other}
                disabled={busy}
                onChange={(e) =>
                  patch(q.id, (d) => ({
                    ...d,
                    other: e.target.value,
                    picked: q.multiSelect ? d.picked : e.target.value ? [] : d.picked,
                  }))
                }
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && answers) void submit(answers)
                }}
              />
            )}
            {!open && answered && (
              <div className="question-answer">{q.secret ? '••••••' : answered.join(', ')}</div>
            )}
          </div>
        )
      })}

      {open && (
        <div className="approval-actions">
          <button
            className="allow"
            disabled={busy || !answers}
            onClick={() => void submit(answers!)}
          >
            {busy ? 'Sending…' : 'Send answer'}
          </button>
          <button disabled={busy} onClick={() => void submit(undefined)}>
            Dismiss
          </button>
        </div>
      )}
      {error && (
        <p className="approval-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
