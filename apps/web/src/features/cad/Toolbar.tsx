import type { LucideIcon } from 'lucide-react'
import {
  ArrowUpFromLine,
  Blend,
  Box,
  Circle,
  CircleDot,
  Combine,
  Cylinder,
  Download,
  DraftingCompass,
  Expand,
  MousePointer2,
  Pencil,
  PenLine,
  RotateCw,
  Ruler,
  Scissors,
  Shrink,
  Spline,
  Square,
  Triangle,
  Upload,
} from 'lucide-react'
import type { SketchToolName } from './sketcher/project.ts'

export type CadTool =
  | 'select'
  | 'sketch'
  | 'box'
  | 'cylinder'
  | 'sphere'
  | 'extrude'
  | 'revolve'
  | 'fillet'
  | 'chamfer'
  | 'hole'
  | 'union'
  | 'cut'
  | 'intersect'
  | 'measure'
  | 'import'
  | 'export'

/** Sketch sub-tools. Separate from `CadTool` so the main toolbar stays compatible. */
export type SketchTool = SketchToolName

export const SKETCH_TOOLS: { id: SketchTool; label: string; title: string; Icon: LucideIcon }[] = [
  { id: 'line', label: 'Line', title: 'Sketch line', Icon: PenLine },
  { id: 'rectangle', label: 'Rect', title: 'Sketch rectangle', Icon: Square },
  { id: 'circle', label: 'Circle', title: 'Sketch circle', Icon: Circle },
  { id: 'arc', label: 'Arc', title: 'Sketch arc', Icon: DraftingCompass },
]

export const CAD_TOOLS: { id: CadTool; label: string; title: string; Icon: LucideIcon }[] = [
  { id: 'select', label: 'Select', title: 'Select', Icon: MousePointer2 },
  { id: 'sketch', label: 'Sketch', title: 'Sketch', Icon: Pencil },
  { id: 'box', label: 'Box', title: 'New box', Icon: Box },
  { id: 'cylinder', label: 'Cylinder', title: 'Cylinder', Icon: Cylinder },
  { id: 'sphere', label: 'Sphere', title: 'Sphere', Icon: Circle },
  { id: 'extrude', label: 'Extrude', title: 'Extrude', Icon: ArrowUpFromLine },
  { id: 'revolve', label: 'Revolve', title: 'Revolve', Icon: RotateCw },
  { id: 'fillet', label: 'Fillet', title: 'Fillet', Icon: Spline },
  { id: 'chamfer', label: 'Chamfer', title: 'Chamfer', Icon: Triangle },
  { id: 'hole', label: 'Hole', title: 'Hole', Icon: CircleDot },
  { id: 'union', label: 'Union', title: 'Union', Icon: Combine },
  { id: 'cut', label: 'Cut', title: 'Cut', Icon: Scissors },
  { id: 'intersect', label: 'Intersect', title: 'Intersect', Icon: Blend },
  { id: 'measure', label: 'Measure', title: 'Measure', Icon: Ruler },
  { id: 'import', label: 'Import', title: 'Import', Icon: Upload },
  { id: 'export', label: 'Export', title: 'Export', Icon: Download },
]

export function Toolbar({
  active,
  onCommand,
  sketchTool = null,
  onSketchTool,
  maximized = false,
  onMaximize,
}: {
  active: CadTool
  onCommand(tool: CadTool): void
  /** When `onSketchTool` is set, line / rect / circle / arc sit beside the main tools. */
  sketchTool?: SketchTool | null
  onSketchTool?(tool: SketchTool): void
  maximized?: boolean
  onMaximize?(): void
}) {
  return (
    <div className="cad-toolbar" role="toolbar" aria-label="CAD tools">
      {CAD_TOOLS.map(({ id, label, title, Icon }) => (
        <button
          key={id}
          type="button"
          className="cad-tool"
          aria-pressed={active === id}
          aria-label={title}
          title={title}
          onClick={() => onCommand(id)}
        >
          <Icon size={14} />
          {label}
        </button>
      ))}
      {onSketchTool ? (
        <div className="cad-sketch-tools" role="group" aria-label="Sketch tools">
          {SKETCH_TOOLS.map(({ id, label, title, Icon }) => (
            <button
              key={id}
              type="button"
              className="cad-tool"
              aria-pressed={sketchTool === id}
              aria-label={title}
              title={title}
              onClick={() => onSketchTool(id)}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {onMaximize ? (
        <button
          type="button"
          className="cad-tool cad-maximize"
          aria-pressed={maximized}
          aria-label={maximized ? 'Shrink CAD pane' : 'Maximize CAD pane'}
          title={maximized ? 'Shrink' : 'Maximize'}
          onClick={onMaximize}
        >
          {maximized ? <Shrink size={14} /> : <Expand size={14} />}
          {maximized ? 'Shrink' : 'Max'}
        </button>
      ) : null}
    </div>
  )
}
