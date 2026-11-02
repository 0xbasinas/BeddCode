import { describe, expect, it, vi } from 'vitest'
import type { DesignElement } from './store/editor-store'
import { layoutTree } from './agentRender'

vi.mock('./lib/text-measure', () => ({
  measureText: (_style: unknown, _mode: string, width: number) => ({
    width, height: width < 100 ? 40 : 20, lines: [],
  }),
}))

const element = (props: Record<string, unknown>) => ({
  id: 'item', type: 'rectangle', x: 0, y: 0, width: 100, height: 20,
  visible: true, ...props,
}) as DesignElement

describe('agent layout', () => {
  it('remeasures fill-width text and moves following siblings after wrapping', async () => {
    const root = element({
      id: 'root', type: 'frame', width: 80, height: 200,
      autoLayout: { direction: 'vertical', gap: 4, paddingTop: 0, paddingBottom: 0, paddingLeft: 0, paddingRight: 0 },
      children: [
        element({ id: 'text', type: 'text', textContent: 'A long label', textAutoResize: 'grow', layoutSizingH: 'fill' }),
        element({ id: 'next' }),
      ],
    })
    const result = await layoutTree(root)
    expect(result.children?.[0]).toMatchObject({ width: 80, height: 40, y: 0 })
    expect(result.children?.[1]?.y).toBe(44)
  })
})
