import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ProviderInstance } from '@beddcode/contracts'
import { SwitchMarkerView } from './SwitchMarker.tsx'

const providers = [
  { id: 'claude-1', label: 'Claude Code' },
  { id: 'grok-1', label: 'Grok' },
] as ProviderInstance[]
const note = '# Handoff\n\n## Goal\nShip the switch UI\n\n## Changed files\nsrc/a.ts +3/-1'

describe('switch marker', () => {
  const html = renderToStaticMarkup(
    <SwitchMarkerView
      item={{ from: 'claude-1', to: 'grok-1', handoff: note }}
      providers={providers}
    />,
  )

  it('names the agents by display name', () => {
    expect(html).toContain('Switched from Claude Code to Grok')
    expect(html).not.toContain('claude-1')
  })

  it('is collapsed by default and holds the note sections', () => {
    expect(html).toMatch(/^<details(?![^>]* open)/)
    expect(html).toContain('<h4>Goal</h4>')
    expect(html).toContain('Ship the switch UI')
    expect(html).toContain('<h4>Changed files</h4>')
  })

  it('falls back to the instance id without providers', () => {
    const bare = renderToStaticMarkup(
      <SwitchMarkerView item={{ from: 'a', to: 'b', handoff: note }} />,
    )
    expect(bare).toContain('Switched from a to b')
  })

  it('shows the carried permission mode in the expanded marker', () => {
    const carried = renderToStaticMarkup(
      <SwitchMarkerView
        item={{ from: 'claude-1', to: 'grok-1', handoff: note, permissionLabel: 'Full access' }}
        providers={providers}
      />,
    )
    expect(carried).toContain('Permissions: Full access')
  })

  it('shows the downgrade note instead when the mode could not be carried', () => {
    const downgraded = renderToStaticMarkup(
      <SwitchMarkerView
        item={{
          from: 'claude-1',
          to: 'grok-1',
          handoff: note,
          permissionLabel: 'Accept edits',
          permissionNote: "Full access isn't available in Grok; using Accept edits.",
        }}
        providers={providers}
      />,
    )
    expect(downgraded).toContain('Full access isn&#x27;t available in Grok; using Accept edits.')
    expect(downgraded).not.toContain('Permissions:')
  })
})
