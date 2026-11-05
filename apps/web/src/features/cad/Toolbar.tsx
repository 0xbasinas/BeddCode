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
import { SpinInput } from './SpinInput.tsx'
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

export type SketchPlaneName = 'XY' | 'YZ' | 'ZX'

export type ExportFormat = 'json' | 'step' | 'stl'

/**
 * Defaults for the active tool, before and during creation.
 * The properties panel remains the editor for a feature that is already selected.
 */
export interface ToolOptions {
  filletRadius: number
  /** Written onto the chamfer feature as `radius`. */
  chamferDistance: number
  holeDiameter: number
  holeThroughAll: boolean
  sketchSnap: number
  sketchPlane: SketchPlaneName
  extrudeDistance: number
}

export const DEFAULT_TOOL_OPTIONS: ToolOptions = {
  filletRadius: 1,
  chamferDistance: 1,
  holeDiameter: 8,
  holeThroughAll: true,
  sketchSnap: 1,
  sketchPlane: 'XY',
  extrudeDistance: 10,
}

const PLANES: readonly SketchPlaneName[] = ['XY', 'YZ', 'ZX']

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

export const TOOL_GROUPS: { id: string; label: string; tools: CadTool[] }[] = [
  { id: 'select', label: 'Select', tools: ['select'] },
  { id: 'sketch', label: 'Sketch tools', tools: ['sketch'] },
  { id: 'solids', label: 'Solids', tools: ['box', 'cylinder', 'sphere'] },
  {
    id: 'modify',
    label: 'Modify',
    tools: ['extrude', 'revolve', 'fillet', 'chamfer', 'hole', 'union', 'cut', 'intersect'],
  },
  { id: 'measure', label: 'Measure', tools: ['measure'] },
  { id: 'exchange', label: 'Import/Export', tools: ['import', 'export'] },
]

const TOOL_BY_ID = new Map(CAD_TOOLS.map((tool) => [tool.id, tool]))

type NumberKey =
  'filletRadius' | 'chamferDistance' | 'holeDiameter' | 'sketchSnap' | 'extrudeDistance'

type OptionField =
  | { kind: 'number'; key: NumberKey; label: string; min: number; step: number }
  | { kind: 'boolean'; key: 'holeThroughAll'; label: string }
  | { kind: 'plane'; key: 'sketchPlane'; label: string }

/** Fields the context strip shows for the active tool. Empty when the tool has no defaults. */
export function optionFields(tool: CadTool): OptionField[] {
  if (tool === 'fillet') {
    return [{ kind: 'number', key: 'filletRadius', label: 'Radius', min: 0, step: 0.1 }]
  }
  if (tool === 'chamfer') {
    return [{ kind: 'number', key: 'chamferDistance', label: 'Distance', min: 0, step: 0.1 }]
  }
  if (tool === 'hole') {
    return [
      { kind: 'number', key: 'holeDiameter', label: 'Diameter', min: 0.1, step: 0.1 },
      { kind: 'boolean', key: 'holeThroughAll', label: 'Through all' },
    ]
  }
  if (tool === 'sketch') {
    return [
      { kind: 'number', key: 'sketchSnap', label: 'Snap', min: 0.1, step: 0.5 },
      { kind: 'plane', key: 'sketchPlane', label: 'Plane' },
    ]
  }
  if (tool === 'extrude') {
    return [{ kind: 'number', key: 'extrudeDistance', label: 'Distance', min: 0, step: 0.5 }]
  }
  return []
}

/** Prompt for the status line. Face and edge wording matches the pick tools. */
export function toolStatusHint(tool: CadTool, sketchTool?: SketchTool | null): string {
  switch (tool) {
    case 'select':
      return 'Pick face. Pick edges (Shift multi).'
    case 'fillet':
    case 'chamfer':
      return 'Pick edges (Shift multi)'
    case 'hole':
      return 'Pick face'
    case 'sketch':
      if (sketchTool === 'rectangle') return 'Pick corner'
      if (sketchTool === 'circle') return 'Pick center'
      if (sketchTool === 'arc') return 'Pick start'
      return 'Pick first point. Pick next point or finish.'
    case 'extrude':
      return 'Set distance'
    case 'revolve':
      return 'Select a sketch to revolve'
    case 'union':
    case 'cut':
    case 'intersect':
      return 'Select two solids. The previous selection is the target and the current one is the tool.'
    case 'measure':
      return 'Pick a solid to measure'
    case 'import':
      return 'Choose a JSON or STEP file'
    case 'export':
      return 'Choose JSON, STEP, or STL'
    case 'box':
      return 'Box on the ground plane'
    case 'cylinder':
      return 'Cylinder on the ground plane'
    case 'sphere':
      return 'Sphere on the ground plane'
    default:
      return 'Pick face'
  }
}

/**
 * Params to stamp onto a feature created by the active tool.
 * Chamfer distance is stored as `radius`, which is the feature field.
 */
export function draftParamPatch(
  kind: string,
  options: ToolOptions,
): Record<string, number | string | boolean> | null {
  if (kind === 'fillet') return { radius: options.filletRadius }
  if (kind === 'chamfer') return { radius: options.chamferDistance }
  if (kind === 'extrude') return { distance: options.extrudeDistance }
  if (kind === 'hole') {
    return { diameter: options.holeDiameter, throughAll: options.holeThroughAll }
  }
  if (kind === 'sketch') return { plane: options.sketchPlane }
  return null
}

/** `now` writes the in-progress feature immediately. `soon` waits until typing pauses. */
export function draftWriteMode(patch: Partial<ToolOptions>): 'now' | 'soon' | 'none' {
  if (patch.holeThroughAll !== undefined) return 'now'
  if (
    patch.filletRadius !== undefined ||
    patch.chamferDistance !== undefined ||
    patch.holeDiameter !== undefined ||
    patch.extrudeDistance !== undefined
  ) {
    return 'soon'
  }
  return 'none'
}

export function parseOptionNumber(raw: string, min: number): number | null {
  const text = raw.trim()
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value)) return null
  return value < min ? min : value
}

export function Toolbar({
  active,
  onCommand,
  sketchTool = null,
  onSketchTool,
  maximized = false,
  onMaximize,
  options,
  onOptionsChange,
  onExport,
}: {
  active: CadTool
  onCommand(tool: CadTool): void
  /** When `onSketchTool` is set, line / rect / circle / arc sit in the Sketch group. */
  sketchTool?: SketchTool | null
  onSketchTool?(tool: SketchTool): void
  maximized?: boolean
  onMaximize?(): void
  /** Active-tool defaults. Omitted callers see `DEFAULT_TOOL_OPTIONS`. */
  options?: ToolOptions
  onOptionsChange?(patch: Partial<ToolOptions>): void
  onExport?(format: ExportFormat): void
}) {
  const current = options ?? DEFAULT_TOOL_OPTIONS
  return (
    <header className="cad-chrome">
      <div className="cad-toolbar" role="toolbar" aria-label="CAD tools">
        <div className="cad-tool-groups">
          {TOOL_GROUPS.map((group) => (
            <div
              key={group.id}
              className="cad-tool-group"
              role="group"
              aria-label={group.label}
            >
              <div className="cad-tool-group-buttons">
                {group.tools.map((id) => (
                  <ToolButton key={id} id={id} active={active} onCommand={onCommand} />
                ))}
                {group.id === 'sketch' && onSketchTool
                  ? SKETCH_TOOLS.map(({ id, label, title, Icon }) => (
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
                    ))
                  : null}
              </div>
              <div className="cad-tool-group-label">{group.label}</div>
            </div>
          ))}
        </div>
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
      <OptionsStrip
        active={active}
        sketchTool={sketchTool}
        options={current}
        onOptionsChange={onOptionsChange}
        onExport={onExport}
      />
    </header>
  )
}

function ToolButton({
  id,
  active,
  onCommand,
}: {
  id: CadTool
  active: CadTool
  onCommand(tool: CadTool): void
}) {
  const tool = TOOL_BY_ID.get(id)
  if (!tool) return null
  const { label, title, Icon } = tool
  return (
    <button
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
  )
}

function OptionsStrip({
  active,
  sketchTool,
  options,
  onOptionsChange,
  onExport,
}: {
  active: CadTool
  sketchTool: SketchTool | null
  options: ToolOptions
  onOptionsChange?(patch: Partial<ToolOptions>): void
  onExport?(format: ExportFormat): void
}) {
  const fields = optionFields(active)
  const disabled = !onOptionsChange
  return (
    <div className="cad-options" role="group" aria-label="Tool options" data-tool={active}>
      <span className="cad-options-hint">{toolStatusHint(active, sketchTool)}</span>
      {fields.map((field) => {
        if (field.kind === 'number') {
          const raw = options[field.key]
          const value = typeof raw === 'number' ? raw : field.min
          return (
            <NumberOption
              key={field.key}
              field={field}
              value={value}
              disabled={disabled}
              onOptionsChange={onOptionsChange}
            />
          )
        }
        if (field.kind === 'boolean') {
          return (
            <label key={field.key} className="cad-option">
              <input
                type="checkbox"
                checked={options.holeThroughAll}
                disabled={disabled}
                onChange={(event) => onOptionsChange?.({ holeThroughAll: event.target.checked })}
              />
              <span>{field.label}</span>
            </label>
          )
        }
        return (
          <div key={field.key} className="cad-option" role="group" aria-label={field.label}>
            <span>{field.label}</span>
            <div className="cad-option-planes">
              {PLANES.map((plane) => (
                <button
                  key={plane}
                  type="button"
                  aria-pressed={options.sketchPlane === plane}
                  disabled={disabled}
                  onClick={() => onOptionsChange?.({ sketchPlane: plane })}
                >
                  {plane}
                </button>
              ))}
            </div>
          </div>
        )
      })}
      {active === 'export' ? (
        <>
          <button type="button" className="cad-tool" onClick={() => onExport?.('json')}>
            JSON
          </button>
          <button type="button" className="cad-tool" onClick={() => onExport?.('step')}>
            STEP
          </button>
          <button type="button" className="cad-tool" onClick={() => onExport?.('stl')}>
            STL
          </button>
        </>
      ) : null}
    </div>
  )
}

function NumberOption({
  field,
  value,
  disabled,
  onOptionsChange,
}: {
  field: Extract<OptionField, { kind: 'number' }>
  value: number
  disabled: boolean
  onOptionsChange?(patch: Partial<ToolOptions>): void
}) {
  return (
    <SpinInput
      className="cad-option"
      label={field.label}
      value={value}
      min={field.min}
      step={field.step}
      disabled={disabled}
      onCommit={(next) => emitNumber(field, String(next), onOptionsChange)}
    />
  )
}

function emitNumber(
  field: Extract<OptionField, { kind: 'number' }>,
  raw: string,
  onOptionsChange?: (patch: Partial<ToolOptions>) => void,
) {
  if (!onOptionsChange) return
  const parsed = parseOptionNumber(raw, field.min)
  if (parsed === null) return
  if (field.key === 'filletRadius') onOptionsChange({ filletRadius: parsed })
  else if (field.key === 'chamferDistance') onOptionsChange({ chamferDistance: parsed })
  else if (field.key === 'holeDiameter') onOptionsChange({ holeDiameter: parsed })
  else if (field.key === 'sketchSnap') onOptionsChange({ sketchSnap: parsed })
  else onOptionsChange({ extrudeDistance: parsed })
}
