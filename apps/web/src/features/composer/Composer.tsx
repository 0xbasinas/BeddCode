import {
  useEffect,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type ReactNode,
} from 'react'
import { ArrowUp, Paperclip, Plus, Square, X } from 'lucide-react'
import { Dropdown } from '../../ui/Dropdown.tsx'
import { formatBytes } from '../../ui/format.ts'
import type { SlashCommand } from '@beddcode/contracts'
import {
  attachUpload,
  attachmentDraftKey,
  EMPTY_ATTACHMENTS,
  useAttachments,
} from './attachments.ts'
import { insertCommand, insertMention, matchCommands, mentionAt } from '@beddcode/client-runtime'
import { hostRequest } from '../../stores/host.ts'
import { FileIcon } from '../files/FileIcon.tsx'
import { ModeMenu, type ModeItem } from './Menus.tsx'

interface ComposerProps {
  text: string
  onTextChange(text: string): void
  placeholder: string
  /** A turn is running or waiting on an answer: show Stop instead of Send. */
  busy: boolean
  disabled?: boolean
  /** Why sending is not possible yet (connecting, loading the agent); shown when the user tries. */
  disabledReason?: string
  autoFocus?: boolean
  /** The box takes focus whenever this changes to a new, set value (e.g. the agent awaits a reply). */
  focusSignal?: string | number
  /** The host files are uploaded to; attachments must live where the agent runs. */
  hostKey: string
  /** Session id, or a separate draft for the new-session composer. */
  draftId?: string
  onSend(text: string, attachmentIds: string[]): Promise<void>
  onStop?(): void
  modes?: ModeItem[]
  modeId?: string
  onModeChange?(id: string): void
  /** Right-hand side of the toolbar: the model/effort control. */
  modelSlot?: ReactNode
  /** The strip under the composer (agent, folder, host, stats). */
  footer?: ReactNode
  /** The folder the agent works in; typing `@` lists its files to mention. */
  cwd?: string
  /** Slash commands and skills the agent offers; typing `/` lists them. */
  commands?: SlashCommand[]
  /** Shown above the box: the agent's plan, queued messages. */
  above?: ReactNode
}

export function Composer(props: ComposerProps) {
  const draftId = props.draftId ?? 'new-session'
  const draft = attachmentDraftKey(props.hostKey, draftId)
  const files = useAttachments((s) => s.drafts[draft] ?? EMPTY_ATTACHMENTS)
  const latest = useRef({ draft, text: props.text })
  latest.current = { draft, text: props.text }
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const [error, setError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    if (props.focusSignal !== undefined) box.current?.focus()
  }, [props.focusSignal])

  const addFiles = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      void attachUpload(props.hostKey, draftId, file)
    }
  }

  const ready = files.filter((f) => f.status === 'done')
  const pending = files.some((f) => f.status !== 'done')
  // Sending is allowed while the agent works: the host steers the message in or queues it.
  const canSend =
    !props.disabled && !pending && !sending && (props.text.trim().length > 0 || ready.length > 0)

  const hasContent = props.text.trim().length > 0 || files.length > 0
  // Enter (or Send) while the host is still connecting or the agent or an upload is still loading
  // is not dropped: the message goes out as soon as it can.
  const [armed, setArmed] = useState<string>()
  const waitingToSend = armed === draft && hasContent
  useEffect(() => {
    if (armed !== undefined && (armed !== draft || !hasContent)) setArmed(undefined)
  }, [armed, draft, hasContent])
  useEffect(() => setError(null), [draft])
  const trySend = () => {
    if (canSend) void send()
    else if (hasContent && !sending) setArmed(draft)
  }

  const send = async () => {
    if (!canSend || sendingRef.current) return
    setArmed(undefined)
    sendingRef.current = true
    setSending(true)
    setError(null)
    try {
      const sent = props.text
      const request = props.onSend(
        sent.trim(),
        ready.map((f) => f.id!),
      )
      // The box empties as Enter is pressed instead of when the host answers; a failure puts the
      // words back (unless something new was typed meanwhile).
      if (mounted.current && latest.current.draft === draft && latest.current.text === sent) {
        props.onTextChange('')
      }
      try {
        await request
      } catch (err) {
        if (mounted.current && latest.current.draft === draft && latest.current.text === '') {
          props.onTextChange(sent)
        }
        throw err
      }
      useAttachments.getState().remove(
        draft,
        ready.map((f) => f.key),
      )
    } catch (err) {
      if (mounted.current && latest.current.draft === draft)
        setError(err instanceof Error ? err.message : 'Could not send')
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }

  useEffect(() => {
    if (waitingToSend && canSend) void send()
  }, [waitingToSend, canSend])

  const matches = matchCommands(props.text, props.commands)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashClosed, setSlashClosed] = useState<string | null>(null)
  const slashOpen = matches.length > 0 && slashClosed !== props.text
  useEffect(() => setSlashIndex(0), [props.text])
  const choose = (command: SlashCommand) => {
    props.onTextChange(insertCommand(command))
    setSlashClosed(null)
  }

  // `@` mentions: files of the working folder that match what follows the `@`.
  const [caret, setCaret] = useState(0)
  const mention = props.cwd && !slashOpen ? mentionAt(props.text, caret) : undefined
  const mentionKey = mention ? `${mention.start}:${mention.query}` : ''
  const [paths, setPaths] = useState<{ key: string; list: string[] }>()
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionClosed, setMentionClosed] = useState<string>()
  useEffect(() => {
    if (!mention?.query || !props.cwd) return
    let cancelled = false
    const timer = setTimeout(() => {
      hostRequest(props.hostKey, 'files.search', { cwd: props.cwd!, query: mention.query }).then(
        (r) => !cancelled && setPaths({ key: mentionKey, list: r.paths.slice(0, 8) }),
        () => !cancelled && setPaths({ key: mentionKey, list: [] }),
      )
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [props.hostKey, props.cwd, mentionKey])
  const mentionPaths = paths?.key === mentionKey ? paths.list : []
  const mentionOpen = mentionPaths.length > 0 && mentionClosed !== mentionKey
  useEffect(() => setMentionIndex(0), [mentionKey])
  const chooseMention = (path: string) => {
    if (!mention) return
    const next = insertMention(props.text, caret, mention, path)
    props.onTextChange(next.text)
    setCaret(next.caret)
    requestAnimationFrame(() => box.current?.setSelectionRange(next.caret, next.caret))
  }

  const onPaste = (e: ClipboardEvent) => {
    const pasted = Array.from(e.clipboardData.files)
    if (pasted.length > 0) {
      e.preventDefault()
      addFiles(pasted)
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
  }

  return (
    <div className="composer-wrap">
      {props.above}
      <div
        className={`composer ${dragging ? 'dragging' : ''}`}
        onClick={(event) => {
          // The whole writing area focuses the input; its controls keep their own focus.
          if (
            event.target instanceof Element &&
            !event.target.closest(
              'button, input, textarea, select, a, [role="menu"], [role="listbox"]',
            )
          )
            box.current?.focus()
        }}
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        {files.length > 0 && (
          <div className="chips">
            {files.map((f) => (
              <span
                key={f.key}
                className={`chip ${f.status}`}
                title={f.error ?? formatBytes(f.size)}
              >
                <Paperclip size={12} /> {f.name}
                {f.status === 'uploading' && <span className="muted">uploading…</span>}
                {f.status === 'error' && <span className="muted">{f.error}</span>}
                <button
                  aria-label={`Remove ${f.name}`}
                  onClick={() => useAttachments.getState().remove(draft, [f.key])}
                >
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        {slashOpen && (
          <div className="slash-menu" role="listbox" aria-label="Commands">
            {matches.map((c, i) => (
              <button
                key={c.name}
                role="option"
                aria-selected={i === slashIndex}
                className={`slash-row ${i === slashIndex ? 'active' : ''}`}
                onMouseEnter={() => setSlashIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(c)
                }}
              >
                <code>/{c.name}</code>
                {c.hint && <span className="muted">{c.hint}</span>}
                {c.description && <span className="slash-desc">{c.description}</span>}
                {c.kind === 'skill' && <span className="slash-kind">skill</span>}
              </button>
            ))}
          </div>
        )}
        {mentionOpen && (
          <div className="slash-menu" role="listbox" aria-label="Files">
            {mentionPaths.map((p, i) => (
              <button
                key={p}
                role="option"
                aria-selected={i === mentionIndex}
                className={`slash-row mention-row ${i === mentionIndex ? 'active' : ''}`}
                onMouseEnter={() => setMentionIndex(i)}
                onMouseDown={(e) => {
                  e.preventDefault()
                  chooseMention(p)
                }}
              >
                <FileIcon name={p} />
                <span className="mention-name">{p.split('/').pop()}</span>
                <span className="slash-desc">
                  {p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''}
                </span>
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={box}
          aria-label="Message"
          value={props.text}
          placeholder={props.placeholder}
          rows={2}
          autoFocus={props.autoFocus}
          onChange={(e) => {
            props.onTextChange(e.target.value)
            setCaret(e.target.selectionStart)
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onPaste={onPaste}
          onKeyDown={(e) => {
            if (mentionOpen && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setMentionIndex(
                  (i) =>
                    (i + (e.key === 'ArrowDown' ? 1 : -1) + mentionPaths.length) %
                    mentionPaths.length,
                )
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                chooseMention(mentionPaths[mentionIndex] ?? mentionPaths[0]!)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setMentionClosed(mentionKey)
                return
              }
            }
            if (slashOpen && !e.nativeEvent.isComposing) {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashIndex(
                  (i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length,
                )
                return
              }
              if (e.key === 'Enter' || e.key === 'Tab') {
                e.preventDefault()
                choose(matches[slashIndex] ?? matches[0]!)
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setSlashClosed(props.text)
                return
              }
            }
            // keyCode 229: some IMEs report a composition's Enter without isComposing.
            const composing = e.nativeEvent.isComposing || e.keyCode === 229
            if (e.key === 'Enter' && !e.shiftKey && !composing) {
              e.preventDefault()
              trySend()
              return
            }
            if (e.key === 'Escape' && waitingToSend) {
              e.preventDefault()
              setArmed(undefined)
            }
          }}
        />
        <div className="toolbar">
          <Dropdown
            trigger={({ toggle }) => (
              <button className="icon-btn" onClick={toggle} aria-label="Add">
                <Plus size={18} />
              </button>
            )}
          >
            {(close) => (
              <button
                className="menu-row"
                onClick={() => {
                  close()
                  input.current?.click()
                }}
              >
                <Paperclip size={16} />
                <span className="menu-text">
                  <span className="menu-title">Add files or photos</span>
                </span>
              </button>
            )}
          </Dropdown>
          <input
            ref={input}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files)
              e.target.value = ''
            }}
          />
          {props.modes && props.modes.length > 0 && props.onModeChange && (
            <ModeMenu modes={props.modes} modeId={props.modeId} onChange={props.onModeChange} />
          )}
          <span className="spacer" />
          {props.modelSlot}
          {props.busy && (
            <button className="send stop" title="Stop" aria-label="Stop" onClick={props.onStop}>
              <Square size={14} fill="currentColor" />
            </button>
          )}
          <button
            className="send"
            title={props.busy ? 'Send (steers the agent, or queues it)' : 'Send'}
            aria-label="Send"
            disabled={!canSend && !(hasContent && !sending && (props.disabled || pending))}
            aria-busy={waitingToSend || sending}
            onClick={trySend}
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
      {waitingToSend && !error && (
        <div className="composer-waiting" role="status">
          <span className="spinner-dot" aria-hidden />
          Sends as soon as{' '}
          {props.disabledReason ?? (pending ? 'your files are uploaded' : 'it can')}
          <button className="link-btn" onClick={() => setArmed(undefined)}>
            Cancel
          </button>
        </div>
      )}
      {error && <div className="composer-error">{error}</div>}
      {props.footer}
    </div>
  )
}
