import type { LucideIcon } from 'lucide-react'
import {
  ArrowUpFromLine,
  Blend,
  Box,
  Circle,
  Combine,
  Cylinder,
  Download,
  MousePointer2,
  Pencil,
  RotateCw,
  Ruler,
  Scissors,
  Spline,
  Triangle,
  Upload,
} from 'lucide-react'

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
  | 'union'
  | 'cut'
  | 'intersect'
  | 'measure'
  | 'import'
  | 'export'

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
}: {
  active: CadTool
  onCommand(tool: CadTool): void
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
    </div>
  )
}
