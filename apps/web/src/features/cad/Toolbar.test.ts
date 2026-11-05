import { describe, expect, it } from 'vitest'
import {
  CAD_TOOLS,
  DEFAULT_TOOL_OPTIONS,
  TOOL_GROUPS,
  draftParamPatch,
  draftWriteMode,
  optionFields,
  parseOptionNumber,
  toolStatusHint,
} from './Toolbar.tsx'

describe('toolbar groups', () => {
  it('orders the ribbon sections', () => {
    expect(TOOL_GROUPS.map((group) => group.label)).toEqual([
      'Select',
      'Sketch tools',
      'Solids',
      'Modify',
      'Measure',
      'Import/Export',
    ])
    expect(TOOL_GROUPS.find((group) => group.label === 'Solids')?.tools).toEqual([
      'box',
      'cylinder',
      'sphere',
    ])
    expect(TOOL_GROUPS.find((group) => group.label === 'Modify')?.tools).toEqual([
      'extrude',
      'revolve',
      'fillet',
      'chamfer',
      'hole',
      'union',
      'cut',
      'intersect',
    ])
  })

  it('places every tool in one group', () => {
    const ids = TOOL_GROUPS.flatMap((group) => group.tools)
    expect(new Set(ids).size).toBe(ids.length)
    expect([...ids].sort()).toEqual(CAD_TOOLS.map((tool) => tool.id).sort())
  })
})

describe('tool status hints', () => {
  it('names the face and edge prompts', () => {
    expect(toolStatusHint('select')).toBe('Pick face. Pick edges (Shift multi).')
    expect(toolStatusHint('hole')).toBe('Pick face')
    expect(toolStatusHint('fillet')).toBe('Pick edges (Shift multi)')
    expect(toolStatusHint('chamfer')).toBe('Pick edges (Shift multi)')
  })

  it('names the sketch step', () => {
    expect(toolStatusHint('sketch', 'line')).toBe('Pick first point. Pick next point or finish.')
    expect(toolStatusHint('sketch', 'rectangle')).toBe('Pick corner')
    expect(toolStatusHint('sketch', 'circle')).toBe('Pick center')
    expect(toolStatusHint('sketch', null)).toBe('Pick first point. Pick next point or finish.')
  })
})

describe('tool options', () => {
  it('starts from the feature defaults', () => {
    expect(DEFAULT_TOOL_OPTIONS).toMatchObject({
      filletRadius: 4,
      chamferDistance: 4,
      holeDiameter: 8,
      holeThroughAll: true,
      sketchSnap: 1,
      sketchPlane: 'XY',
      extrudeDistance: 10,
    })
  })

  it('lists strip fields for the active tool', () => {
    expect(optionFields('fillet').map((field) => field.label)).toEqual(['Radius'])
    expect(optionFields('chamfer').map((field) => field.label)).toEqual(['Distance'])
    expect(optionFields('hole').map((field) => field.label)).toEqual(['Diameter', 'Through all'])
    expect(optionFields('sketch').map((field) => field.label)).toEqual(['Snap', 'Plane'])
    expect(optionFields('extrude').map((field) => field.label)).toEqual(['Distance'])
    expect(optionFields('select')).toEqual([])
    expect(optionFields('measure')).toEqual([])
  })

  it('stamps creation params from the strip', () => {
    expect(draftParamPatch('fillet', DEFAULT_TOOL_OPTIONS)).toEqual({ radius: 4 })
    expect(draftParamPatch('chamfer', { ...DEFAULT_TOOL_OPTIONS, chamferDistance: 2.5 })).toEqual({
      radius: 2.5,
    })
    expect(
      draftParamPatch('hole', {
        ...DEFAULT_TOOL_OPTIONS,
        holeDiameter: 6,
        holeThroughAll: false,
      }),
    ).toEqual({ diameter: 6, throughAll: false })
    expect(draftParamPatch('extrude', { ...DEFAULT_TOOL_OPTIONS, extrudeDistance: 25 })).toEqual({
      distance: 25,
    })
    expect(draftParamPatch('sketch', { ...DEFAULT_TOOL_OPTIONS, sketchPlane: 'YZ' })).toEqual({
      plane: 'YZ',
    })
    expect(draftParamPatch('box', DEFAULT_TOOL_OPTIONS)).toBeNull()
  })

  it('writes a checkbox immediately and a typed number after a pause', () => {
    expect(draftWriteMode({ holeThroughAll: false })).toBe('now')
    expect(draftWriteMode({ filletRadius: 2 })).toBe('soon')
    expect(draftWriteMode({ extrudeDistance: 12 })).toBe('soon')
    expect(draftWriteMode({ sketchSnap: 5 })).toBe('none')
    expect(draftWriteMode({ sketchPlane: 'ZX' })).toBe('none')
  })

  it('rejects an empty number and clamps below the minimum', () => {
    expect(parseOptionNumber('', 0)).toBeNull()
    expect(parseOptionNumber('  ', 0)).toBeNull()
    expect(parseOptionNumber('nope', 0)).toBeNull()
    expect(parseOptionNumber('-2', 0)).toBe(0)
    expect(parseOptionNumber('0.05', 0.1)).toBe(0.1)
    expect(parseOptionNumber('12.5', 0)).toBe(12.5)
  })
})
