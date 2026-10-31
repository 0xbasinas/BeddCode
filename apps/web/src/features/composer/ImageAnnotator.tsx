import { useEffect, useRef, useState } from 'react'
import {
  Check,
  Circle,
  Eraser,
  EyeOff,
  Hash,
  Highlighter,
  Minus,
  MoveUpRight,
  PaintBucket,
  Pencil,
  Square,
  Type,
  Undo2,
  type LucideIcon,
} from 'lucide-react'

type Tool =
  'pen' | 'highlighter' | 'line' | 'arrow' | 'rect' | 'ellipse' | 'redact' | 'badge' | 'text'

interface Point {
  x: number
  y: number
}

interface Stroke {
  tool: Tool
  color: string
  /** Brush size in image pixels (what the user picked in screen pixels, scaled to the image). */
  size: number
  /** Image pixels per screen pixel when drawn. */
  scale: number
  filled: boolean
  points: Point[]
  /** The words of a text note, or the number of a badge. */
  label?: string
}

const COLORS = [
  '#ef4444',
  '#f59e0b',
  '#facc15',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ffffff',
  '#111111',
]
/** Sizes are in screen pixels, so a 6 looks 6 pixels wide whatever the image's resolution. */
const SIZE_RANGE: Record<Tool, [min: number, max: number, start: number]> = {
  pen: [1, 40, 4],
  highlighter: [6, 80, 18],
  line: [1, 40, 4],
  arrow: [1, 40, 4],
  rect: [1, 40, 4],
  ellipse: [1, 40, 4],
  redact: [1, 1, 1],
  badge: [16, 96, 30],
  text: [10, 96, 22],
}
const DEFAULT_SIZES = Object.fromEntries(
  Object.entries(SIZE_RANGE).map(([tool, [, , start]]) => [tool, start]),
) as Record<Tool, number>
/** What the size means for a tool, shown beside the number. */
const SIZE_UNIT: Partial<Record<Tool, string>> = { badge: 'px across', text: 'px tall' }
/** Tools with a cursor ring showing the mark's real size. */
const HAS_RING: Tool[] = ['pen', 'highlighter', 'line', 'arrow', 'rect', 'ellipse', 'badge']

const TOOLS: { value: Tool; icon: LucideIcon; label: string }[] = [
  { value: 'pen', icon: Pencil, label: 'Pen' },
  { value: 'highlighter', icon: Highlighter, label: 'Highlighter' },
  { value: 'line', icon: Minus, label: 'Line' },
  { value: 'arrow', icon: MoveUpRight, label: 'Arrow' },
  { value: 'rect', icon: Square, label: 'Box' },
  { value: 'ellipse', icon: Circle, label: 'Ellipse' },
  { value: 'redact', icon: EyeOff, label: 'Hide (solid block)' },
  { value: 'badge', icon: Hash, label: 'Numbered marker' },
  { value: 'text', icon: Type, label: 'Text' },
]

/** Shapes drawn by dragging from one corner to the other. */
const DRAGGED: Tool[] = ['line', 'arrow', 'rect', 'ellipse', 'redact']

function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke) {
  const first = s.points[0]
  const last = s.points[s.points.length - 1]
  if (!first || !last) return
  const width = s.size
  ctx.save()
  ctx.strokeStyle = s.color
  ctx.fillStyle = s.color
  ctx.lineWidth = width
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  switch (s.tool) {
    case 'pen':
      ctx.moveTo(first.x, first.y)
      for (const p of s.points) ctx.lineTo(p.x, p.y)
      ctx.stroke()
      break
    case 'highlighter':
      ctx.globalAlpha = 0.35
      ctx.lineWidth = width
      ctx.lineCap = 'butt'
      ctx.moveTo(first.x, first.y)
      for (const p of s.points) ctx.lineTo(p.x, p.y)
      ctx.stroke()
      break
    case 'line':
      ctx.moveTo(first.x, first.y)
      ctx.lineTo(last.x, last.y)
      ctx.stroke()
      break
    case 'arrow': {
      const angle = Math.atan2(last.y - first.y, last.x - first.x)
      const head = width * 3 + 10 * s.scale
      ctx.moveTo(first.x, first.y)
      ctx.lineTo(last.x, last.y)
      for (const turn of [-Math.PI / 7, Math.PI / 7]) {
        ctx.moveTo(last.x, last.y)
        ctx.lineTo(last.x - head * Math.cos(angle + turn), last.y - head * Math.sin(angle + turn))
      }
      ctx.stroke()
      break
    }
    case 'rect':
      if (s.filled) {
        ctx.globalAlpha = 0.25
        ctx.fillRect(first.x, first.y, last.x - first.x, last.y - first.y)
        ctx.globalAlpha = 1
      }
      ctx.strokeRect(first.x, first.y, last.x - first.x, last.y - first.y)
      break
    case 'ellipse': {
      ctx.ellipse(
        (first.x + last.x) / 2,
        (first.y + last.y) / 2,
        Math.abs(last.x - first.x) / 2,
        Math.abs(last.y - first.y) / 2,
        0,
        0,
        Math.PI * 2,
      )
      if (s.filled) {
        ctx.globalAlpha = 0.25
        ctx.fill()
        ctx.globalAlpha = 1
      }
      ctx.stroke()
      break
    }
    case 'redact':
      ctx.fillStyle = '#000'
      ctx.fillRect(first.x, first.y, last.x - first.x, last.y - first.y)
      break
    case 'badge': {
      const radius = width / 2
      ctx.arc(first.x, first.y, radius, 0, Math.PI * 2)
      ctx.fill()
      ctx.lineWidth = Math.max(2 * s.scale, width / 14)
      ctx.strokeStyle = s.color === '#ffffff' ? '#111' : '#fff'
      ctx.stroke()
      ctx.fillStyle = s.color === '#ffffff' || s.color === '#facc15' ? '#111' : '#fff'
      // Digits are about 0.7em tall: size them to fill ~55% of the circle, narrower for two or more.
      const text = s.label ?? ''
      ctx.font = `700 ${(radius * 1.55) / Math.max(1, text.length * 0.75 + 0.25)}px system-ui, sans-serif`
      ctx.textAlign = 'center'
      ctx.textBaseline = 'alphabetic'
      const m = ctx.measureText(text)
      ctx.fillText(
        text,
        first.x,
        first.y + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2,
      )
      break
    }
    case 'text': {
      ctx.font = `700 ${width}px system-ui, sans-serif`
      ctx.textBaseline = 'top'
      ctx.lineWidth = width / 5
      ctx.strokeStyle = s.color === '#111111' ? '#fff' : '#000'
      ctx.strokeText(s.label ?? '', first.x, first.y)
      ctx.fillText(s.label ?? '', first.x, first.y)
      break
    }
  }
  ctx.restore()
}

/**
 * Mark up an image: freehand, highlighter, shapes, hidden blocks, numbered markers and text.
 * `onDone` gets the picture with the marks burned in as a PNG; the original is never changed.
 */
export function ImageAnnotator({ src, onDone }: { src: string; onDone(png: Blob): void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [image, setImage] = useState<ImageBitmap>()
  const [failed, setFailed] = useState(false)
  const [tool, setTool] = useState<Tool>('pen')
  const [color, setColor] = useState(COLORS[0]!)
  // Each tool keeps its own size: a good arrow is thin, a good marker or note is not.
  const [sizes, setSizes] = useState<Record<Tool, number>>(DEFAULT_SIZES)
  const size = sizes[tool]
  const [min, max] = SIZE_RANGE[tool]
  const setSize = (value: number) =>
    setSizes((all) => ({ ...all, [tool]: Math.min(max, Math.max(min, Math.round(value))) }))
  /** Image pixels per screen pixel. */
  const scaleOf = () => {
    const el = canvas.current
    return el ? el.width / (el.getBoundingClientRect().width || el.width) : 1
  }
  const [ring, setRing] = useState<{ left: number; top: number; d: number } | null>(null)
  const [filled, setFilled] = useState(false)
  const [strokes, setStrokes] = useState<Stroke[]>([])
  const [note, setNote] = useState<{ at: Point; left: number; top: number } | null>(null)
  const drawing = useRef<Stroke | null>(null)

  useEffect(() => {
    let live = true
    fetch(src)
      .then((r) => r.blob())
      .then((b) => createImageBitmap(b))
      .then((bitmap) => live && setImage(bitmap))
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [src])

  const paint = (extra?: Stroke | null) => {
    const el = canvas.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx || !image) return
    ctx.clearRect(0, 0, el.width, el.height)
    ctx.drawImage(image, 0, 0)
    for (const s of strokes) drawStroke(ctx, s)
    if (extra) drawStroke(ctx, extra)
  }
  useEffect(() => paint(), [image, strokes]) // eslint-disable-line react-hooks/exhaustive-deps

  const undo = () => setStrokes((s) => s.slice(0, -1))
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        e.key.toLowerCase() === 'z' &&
        !(e.target instanceof HTMLInputElement)
      ) {
        e.preventDefault()
        undo()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || (e.key !== '[' && e.key !== ']')) return
      const [lo, hi] = SIZE_RANGE[tool]
      const step = e.key === ']' ? 2 : -2
      setSizes((all) => ({ ...all, [tool]: Math.min(hi, Math.max(lo, all[tool] + step)) }))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool])

  const at = (e: React.PointerEvent): Point => {
    const el = canvas.current!
    const rect = el.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * el.width,
      y: ((e.clientY - rect.top) / rect.height) * el.height,
    }
  }

  const commitNote = (text: string) => {
    if (note && text.trim()) {
      setStrokes((all) => [
        ...all,
        {
          tool: 'text',
          color,
          size: size * scaleOf(),
          scale: scaleOf(),
          filled,
          points: [note.at],
          label: text.trim(),
        },
      ])
    }
    setNote(null)
  }

  if (failed) return <div className="annotate-status">Could not load this image to annotate.</div>
  if (!image) return <div className="annotate-status">Loading…</div>
  const hasFill = tool === 'rect' || tool === 'ellipse'
  return (
    <div className="annotate" onClick={(e) => e.stopPropagation()}>
      <div className="annotate-bar" role="toolbar" aria-label="Annotate">
        {TOOLS.map(({ value, icon: Icon, label }) => (
          <button
            key={value}
            title={label}
            aria-label={label}
            aria-pressed={tool === value}
            onClick={() => {
              setTool(value)
              setNote(null)
            }}
          >
            <Icon size={15} />
          </button>
        ))}
        <span className="annotate-sep" />
        {COLORS.map((c) => (
          <button
            key={c}
            className="annotate-color"
            aria-label={`Colour ${c}`}
            aria-pressed={color === c}
            style={{ background: c }}
            onClick={() => setColor(c)}
          />
        ))}
        <span className="annotate-sep" />
        <span className="annotate-size" title={`Size ${size}px`}>
          <span className="annotate-preview">
            <span
              className="annotate-dot"
              style={{
                width: Math.min(24, Math.max(2, size)),
                height: Math.min(24, Math.max(2, size)),
                color,
              }}
            />
          </span>
          <button aria-label="Smaller" title="Smaller ([)" onClick={() => setSize(size - 1)}>
            −
          </button>
          <input
            type="range"
            aria-label="Size"
            min={min}
            max={max}
            step={1}
            value={size}
            onChange={(e) => setSize(Number(e.target.value))}
          />
          <button aria-label="Larger" title="Larger (])" onClick={() => setSize(size + 1)}>
            +
          </button>
          <span className="annotate-size-value">
            {size}px{SIZE_UNIT[tool] ? ` ${SIZE_UNIT[tool]!.slice(3)}` : ''}
          </span>
        </span>
        <button
          title="Fill shapes"
          aria-label="Fill shapes"
          aria-pressed={filled}
          disabled={!hasFill}
          onClick={() => setFilled(!filled)}
        >
          <PaintBucket size={15} />
        </button>
        <span className="annotate-sep" />
        <button aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!strokes.length} onClick={undo}>
          <Undo2 size={15} />
        </button>
        <button
          aria-label="Clear"
          title="Clear all"
          disabled={!strokes.length}
          onClick={() => setStrokes([])}
        >
          <Eraser size={15} />
        </button>
        <button
          className="annotate-done"
          disabled={!strokes.length}
          onClick={() => canvas.current?.toBlob((b) => b && onDone(b), 'image/png')}
        >
          <Check size={15} /> Attach
        </button>
      </div>
      <div className="annotate-stage">
        <canvas
          ref={canvas}
          width={image.width}
          height={image.height}
          onPointerDown={(e) => {
            if (tool === 'text') {
              const rect = e.currentTarget.getBoundingClientRect()
              setNote({ at: at(e), left: e.clientX - rect.left, top: e.clientY - rect.top })
              return
            }
            if (tool === 'badge') {
              const n = strokes.filter((s) => s.tool === 'badge').length + 1
              setStrokes((all) => [
                ...all,
                {
                  tool,
                  color,
                  size: size * scaleOf(),
                  scale: scaleOf(),
                  filled,
                  points: [at(e)],
                  label: String(n),
                },
              ])
              return
            }
            e.currentTarget.setPointerCapture(e.pointerId)
            drawing.current = {
              tool,
              color,
              size: size * scaleOf(),
              scale: scaleOf(),
              filled,
              points: [at(e)],
            }
          }}
          onPointerLeave={() => setRing(null)}
          onPointerMove={(e) => {
            if (HAS_RING.includes(tool) && !note) {
              const rect = e.currentTarget.getBoundingClientRect()
              setRing({
                left: e.clientX - rect.left,
                top: e.clientY - rect.top,
                d: Math.max(3, size),
              })
            } else if (ring) setRing(null)
            const s = drawing.current
            if (!s) return
            s.points = DRAGGED.includes(s.tool) ? [s.points[0]!, at(e)] : [...s.points, at(e)]
            paint(s)
          }}
          onPointerUp={() => {
            const s = drawing.current
            drawing.current = null
            if (s && s.points.length > 1) setStrokes((all) => [...all, s])
          }}
        />
        {ring && (
          <span
            className="annotate-ring"
            style={{ left: ring.left, top: ring.top, width: ring.d, height: ring.d }}
          />
        )}
        {note && (
          <input
            className="annotate-note"
            autoFocus
            placeholder="Type, then Enter"
            style={{ left: note.left, top: note.top, color }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitNote(e.currentTarget.value)
              else if (e.key === 'Escape') setNote(null)
            }}
            onBlur={(e) => commitNote(e.currentTarget.value)}
          />
        )}
      </div>
    </div>
  )
}
