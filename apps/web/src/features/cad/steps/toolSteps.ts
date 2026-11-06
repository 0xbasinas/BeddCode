import type { CadTool } from '../Toolbar.tsx'
import { NO_STEPS, type StepSpec } from './steps.ts'

/** Sketch sub-tools, mirrored here so this module does not import the sketcher. */
export type SketchToolId = 'line' | 'polyline' | 'rectangle' | 'polygon' | 'circle' | 'arc'

const FILLET_STEPS: readonly StepSpec[] = [
  {
    id: 'edges',
    prompt: 'Pick edges to fillet, then press Enter',
    accepts: ['edge'],
    tip: 'Type a digit to set the radius',
  },
]

const CHAMFER_STEPS: readonly StepSpec[] = [
  {
    id: 'edges',
    prompt: 'Pick edges to chamfer, then press Enter',
    accepts: ['edge'],
    tip: 'Type a digit to set the distance',
  },
]

const HOLE_STEPS: readonly StepSpec[] = [
  {
    id: 'face',
    prompt: 'Pick a face to place the hole',
    accepts: ['face'],
    tip: 'Type a digit to set the diameter',
  },
]

const BOOLEAN_STEPS: readonly StepSpec[] = [
  {
    id: 'target',
    prompt: 'Pick the target solid',
    accepts: ['face', 'edge', 'vertex'],
    tip: 'Selecting a face selects the solid it belongs to',
  },
  {
    id: 'tool',
    prompt: 'Pick the tool solid',
    accepts: ['face', 'edge', 'vertex'],
    tip: 'The target is kept and the tool is applied to it',
  },
]

const MEASURE_STEPS: readonly StepSpec[] = [
  {
    id: 'solid',
    prompt: 'Pick a solid to measure',
    accepts: ['face', 'edge', 'vertex'],
    tip: 'Volume, surface area, and the bounding box are reported',
  },
]

const EXTRUDE_STEPS: readonly StepSpec[] = [
  {
    id: 'sketch',
    prompt: 'Pick the sketch to extrude',
    accepts: ['face', 'edge', 'vertex'],
    tip: 'Type a digit to set the distance',
  },
]

const REVOLVE_STEPS: readonly StepSpec[] = [
  {
    id: 'sketch',
    prompt: 'Pick the sketch to revolve',
    accepts: ['face', 'edge', 'vertex'],
    tip: 'Revolve sweeps the sketch around the Y axis',
  },
]

const SKETCH_STEPS: Record<SketchToolId, readonly StepSpec[]> = {
  rectangle: [
    { id: 'corner-a', prompt: 'Pick the first corner', accepts: ['point'] },
    { id: 'corner-b', prompt: 'Pick the opposite corner', accepts: ['point'] },
  ],
  circle: [
    { id: 'center', prompt: 'Pick the center', accepts: ['point'] },
    { id: 'radius', prompt: 'Pick a point on the circle', accepts: ['point'] },
  ],
  arc: [
    { id: 'center', prompt: 'Pick the center', accepts: ['point'] },
    { id: 'start', prompt: 'Pick the start point', accepts: ['point'] },
    { id: 'end', prompt: 'Pick the end point', accepts: ['point'] },
  ],
  line: [
    { id: 'start', prompt: 'Pick the first point', accepts: ['point'] },
    { id: 'end', prompt: 'Pick the next point, or press Enter to finish', accepts: ['point'] },
  ],
  // A polyline has no fixed end, so it carries a repeat marker: the host keeps
  // the last step open until the user presses Enter.
  polyline: [
    { id: 'start', prompt: 'Pick the first point', accepts: ['point'] },
    {
      id: 'next',
      prompt: 'Pick points to chain, or press Enter to end the polyline',
      accepts: ['point'],
      repeat: true,
    },
  ],
  polygon: [
    { id: 'center', prompt: 'Pick the center', accepts: ['point'] },
    { id: 'radius', prompt: 'Pick a corner to set the size', accepts: ['point'] },
  ],
}

/**
 * The steps a tool walks through. Tools that finish on one pick return a single
 * step, and tools with nothing to pick return none.
 */
export function stepsFor(tool: CadTool, sketchTool?: SketchToolId | null): readonly StepSpec[] {
  switch (tool) {
    case 'fillet':
      return FILLET_STEPS
    case 'chamfer':
      return CHAMFER_STEPS
    case 'hole':
      return HOLE_STEPS
    case 'union':
    case 'cut':
    case 'intersect':
      return BOOLEAN_STEPS
    case 'measure':
      return MEASURE_STEPS
    case 'extrude':
      return EXTRUDE_STEPS
    case 'revolve':
      return REVOLVE_STEPS
    case 'sketch':
      return sketchTool ? SKETCH_STEPS[sketchTool] : NO_STEPS
    default:
      return NO_STEPS
  }
}
