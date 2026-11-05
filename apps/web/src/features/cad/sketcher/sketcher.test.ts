import { describe, expect, it } from 'vitest'
import { SketchEditor } from './SketchEditor.ts'

describe('sketcher', () => {
  it('drives a rect with width and height dimensions', () => {
    const editor = new SketchEditor({ id: 'profile', name: 'Profile' })
    const rect = editor.addEntity({ kind: 'rect', x: 5, y: 7, width: 10, height: 4 })
    editor.addDimension({ kind: 'width', entityId: rect.id, value: 40 })
    editor.addDimension({ kind: 'height', entityId: rect.id, value: 25 })

    const solved = editor.evaluate()
    const entity = solved.entities.find((item) => item.id === rect.id)
    expect(entity).toMatchObject({ kind: 'rect', x: 5, y: 7, width: 40, height: 25 })
  })

  it('flattens a line and sets its length', () => {
    const editor = new SketchEditor()
    const line = editor.addEntity({ kind: 'line', x1: 0, y1: 0, x2: 3, y2: 4 })
    editor.addConstraint({ kind: 'horizontal', entityId: line.id })
    editor.addConstraint({
      kind: 'distance',
      a: { entityId: line.id, slot: 'start' },
      b: { entityId: line.id, slot: 'end' },
      value: 10,
    })
    const solved = editor.evaluate()
    const entity = solved.entities[0]
    expect(entity).toMatchObject({ kind: 'line', x1: 0, y1: 2, x2: 10, y2: 2 })
  })

  it('sets a circle radius and moves a coincident point', () => {
    const editor = new SketchEditor()
    const circle = editor.addEntity({ kind: 'circle', cx: 1, cy: 2, radius: 3 })
    const point = editor.addEntity({ kind: 'point', x: 0, y: 0 })
    editor.addConstraint({ kind: 'radius', entityId: circle.id, value: 8 })
    editor.addConstraint({
      kind: 'coincident',
      a: { entityId: circle.id, slot: 'center' },
      b: { entityId: point.id, slot: 'origin' },
    })
    const solved = editor.evaluate()
    expect(solved.entities[0]).toMatchObject({ kind: 'circle', cx: 1, cy: 2, radius: 8 })
    expect(solved.entities[1]).toMatchObject({ kind: 'point', x: 1, y: 2 })
  })
})
