import type { NumericFieldOptions } from './inputState.ts'
import type { CadTool, ToolOptions } from '../Toolbar.tsx'

/**
 * The one number worth typing while a tool is active.
 *
 * Chili3D lets a digit open a box over the viewport rather than sending the
 * user to a panel, so this picks the value the active tool most needs.
 * Tools with no single obvious number return null and the box stays shut.
 */
export interface QuickField {
  /** Stable key so the box remounts when the tool's number changes. */
  key: string
  label: string
  value: number
  min: number
  patch(value: number): Partial<ToolOptions>
}

export const MIN_QUICK_VALUE: Record<'filletRadius' | 'chamferDistance' | 'extrudeDistance', number> =
  {
    filletRadius: 0,
    chamferDistance: 0,
    extrudeDistance: 0.001,
  }

export function quickFieldFor(tool: CadTool, options: ToolOptions): QuickField | null {
  if (tool === 'fillet') {
    return {
      key: 'filletRadius',
      label: 'Fillet radius',
      value: options.filletRadius,
      min: MIN_QUICK_VALUE.filletRadius,
      patch: (filletRadius) => ({ filletRadius }),
    }
  }
  if (tool === 'chamfer') {
    return {
      key: 'chamferDistance',
      label: 'Chamfer distance',
      value: options.chamferDistance,
      min: MIN_QUICK_VALUE.chamferDistance,
      patch: (chamferDistance) => ({ chamferDistance }),
    }
  }
  if (tool === 'extrude') {
    return {
      key: 'extrudeDistance',
      label: 'Extrude distance',
      value: options.extrudeDistance,
      min: MIN_QUICK_VALUE.extrudeDistance,
      patch: (extrudeDistance) => ({ extrudeDistance }),
    }
  }
  return null
}

/** Present a quick field as a flyout field, committing through `onPatch`. */
export function quickFieldAsInput(
  field: QuickField,
  onPatch: (patch: Partial<ToolOptions>) => void,
  onCancel?: () => void,
): NumericFieldOptions {
  return {
    label: field.label,
    min: field.min,
    units: 'mm',
    onCommit: (value) => onPatch(field.patch(value)),
    onCancel,
  }
}
