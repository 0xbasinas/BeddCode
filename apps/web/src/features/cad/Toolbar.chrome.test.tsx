import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DEFAULT_TOOL_OPTIONS, Toolbar } from './Toolbar.tsx'

describe('toolbar chrome', () => {
  it('renders ribbon groups and the fillet radius strip', () => {
    const html = renderToStaticMarkup(
      <Toolbar
        active="fillet"
        onCommand={() => {}}
        onSketchTool={() => {}}
        options={DEFAULT_TOOL_OPTIONS}
        onOptionsChange={() => {}}
      />,
    )
    expect(html).toContain('aria-label="Sketch tools"')
    expect(html).toContain('Solids')
    expect(html).toContain('Modify')
    expect(html).toContain('Import/Export')
    expect(html).toContain('aria-label="Radius"')
    expect(html).toContain('Pick edges (Shift multi)')
    expect(html).not.toContain('chili')
  })

  it('renders hole, sketch, and extrude controls', () => {
    const hole = renderToStaticMarkup(
      <Toolbar active="hole" onCommand={() => {}} options={DEFAULT_TOOL_OPTIONS} />,
    )
    expect(hole).toContain('Pick face')
    expect(hole).toContain('Diameter')
    expect(hole).toContain('Through all')
    expect(hole).toContain('checked')

    const sketch = renderToStaticMarkup(
      <Toolbar
        active="sketch"
        sketchTool="line"
        onCommand={() => {}}
        onSketchTool={() => {}}
        options={{ ...DEFAULT_TOOL_OPTIONS, sketchPlane: 'ZX', sketchSnap: 5 }}
        onOptionsChange={() => {}}
      />,
    )
    expect(sketch).toContain('Pick first point')
    expect(sketch).toContain('aria-label="Snap"')
    expect(sketch).toContain('value="5"')
    expect(sketch).toContain('aria-pressed="true">ZX')

    const extrude = renderToStaticMarkup(
      <Toolbar
        active="extrude"
        onCommand={() => {}}
        options={{ ...DEFAULT_TOOL_OPTIONS, extrudeDistance: 25 }}
        onOptionsChange={() => {}}
      />,
    )
    expect(extrude).toContain('Set distance')
    expect(extrude).toContain('aria-label="Distance"')
    expect(extrude).toContain('value="25"')
  })
})
