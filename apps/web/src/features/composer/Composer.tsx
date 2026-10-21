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
import { upload } from '../../stores/host.ts'
import { insertCommand, matchCommands } from './slash.ts'
import { ModeMenu, type ModeItem } from './Menus.tsx'

const MAX_BYTES = 20 * 1024 * 1024

interface Attached {
  key: number
  name: string
  size: number
  status: 'uploading' | 'done' | 'error'
  id?: string
  error?: string
}

interface ComposerProps {
  text: string
  onTextChange(text: string): void
  placeholder: string
  /** A turn is running or waiting on an answer: show Stop instead of Send. */
  busy: boolean
  disabled?: boolean
  autoFocus?: boolean
  /** The host files are uploaded to; attachments must live where the agent runs. */
  hostKey: string
  onSend(text: string, attachmentIds: string[]): Promise<void>
  onStop?(): void
  modes?: ModeItem[]
  modeId?: string
  onModeChange?(id: string): void
  /** Right-hand side of the toolbar: the model/effort control. */
  modelSlot?: ReactNode
  /** The strip under the composer (agent, folder, host, stats). */
  footer?: ReactNode
  /** Slash commands and skills the agent offers; typing `/` lists them. */
  commands?: SlashCommand[]
  /** Shown above the box: the agent's plan, queued messages. */
  above?: ReactNode
}

let nextKey = 1

export function Composer(props: ComposerProps) {
  const [files, setFiles] = useState<Attached[]>([])
  const [error, setError] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const patch = (key: number, next: Partial<Attached>) =>
    setFiles((fs) => fs.map((f) => (f.key === key ? { ...f, ...next } : f)))

  const addFiles = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const key = nextKey++
      const base = { key, name: file.name || 'pasted-file', size: file.size }
      if (file.size > MAX_BYTES) {
        setFiles((fs) => [...fs, { ...base, status: 'error', error: 'Larger than 20 MB' }])
        continue
      }
      setFiles((fs) => [...fs, { ...base, status: 'uploading' }])
      upload(props.hostKey, file).then(
        (saved) => patch(key, { status: 'done', id: saved.id }),
        (err: unknown) =>
          patch(key, {
            status: 'error',
            error: err instanceof Error ? err.message : 'Upload failed',
          }),
      )
    }
  }

  const ready = files.filter((f) => f.status === 'done')
  const uploading = files.some((f) => f.status === 'uploading')
  // Sending is allowed while the agent works: the host steers the message in or queues it.
  const canSend =
    !props.disabled && !uploading && (props.text.trim().length > 0 || ready.length > 0)

  const send = async () => {
    if (!canSend) return
    setError(null)
    try {
      await props.onSend(
        props.text.trim(),
        ready.map((f) => f.id!),
      )
      props.onTextChange('')
      setFiles([])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send')
    }
  }

  const matches = matchCommands(props.text, props.commands)
  const [slashIndex, setSlashIndex] = useState(0)
  const [slashClosed, setSlashClosed] = useState<string | null>(null)
  const slashOpen = matches.length > 0 && slashClosed !== props.text
  useEffect(() => setSlashIndex(0), [props.text])
  const choose = (command: SlashCommand) => {
    props.onTextChange(insertCommand(command))
    setSlashClosed(null)
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
                  onClick={() => setFiles((fs) => fs.filter((x) => x.key !== f.key))}
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
        <textarea
          value={props.text}
          placeholder={props.placeholder}
          rows={2}
          autoFocus={props.autoFocus}
          onChange={(e) => props.onTextChange(e.target.value)}
          onPaste={onPaste}
          onKeyDown={(e) => {
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
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              void send()
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
            disabled={!canSend}
            onClick={() => void send()}
          >
            <ArrowUp size={18} />
          </button>
        </div>
      </div>
      {error && <div className="composer-error">{error}</div>}
      {props.footer}
    </div>
  )
}
