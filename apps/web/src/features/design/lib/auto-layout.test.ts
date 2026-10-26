import { describe, expect, it } from 'vitest'
import { computeAutoLayout } from './auto-layout'
import type { DesignElement } from '../store/editor-store'

const box = (name: string, width: number, height: number): DesignElement =>
  ({ id: name, type: 'rectangle', name, x: 0, y: 0, width, height, visible: true }) as DesignElement

const frame = (autoLayout: Record<string, unknown>, children: DesignElement[]): DesignElement =>
  ({
    id: 'f',
    type: 'frame',
    name: 'f',
    x: 0,
    y: 0,
    width: 400,
    height: 200,
    visible: true,
    autoLayout: {
      gap: 0,
      padding: 0,
      paddingTop: 0,
      paddingRight: 0,
      paddingBottom: 0,
      paddingLeft: 0,
      ...autoLayout,
    },
    children,
  }) as unknown as DesignElement

describe('computeAutoLayout alignment', () => {
  it('centres a lone child across the frame, not only within its own size', () => {
    const out = computeAutoLayout(
      frame({ direction: 'vertical', alignItems: 'center' }, [box('a', 100, 50)]),
    )
    expect(out.children[0]).toMatchObject({ x: 150, y: 0 })
  })

  it('centres the children of a row vertically', () => {
    const out = computeAutoLayout(
      frame({ direction: 'horizontal', alignItems: 'center' }, [
        box('a', 100, 50),
        box('b', 40, 20),
      ]),
    )
    expect(out.children.map((c) => c.y)).toEqual([75, 90])
  })

  it('pushes children to the end of the cross axis', () => {
    const out = computeAutoLayout(
      frame({ direction: 'vertical', alignItems: 'end' }, [box('a', 100, 50)]),
    )
    expect(out.children[0]).toMatchObject({ x: 300 })
  })
})
