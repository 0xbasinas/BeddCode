import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ClaudeBackendSettings } from './ClaudeBackendSettings.tsx'
import { AgentChip, effectiveClaudeBackend } from '../newsession/NewSession.tsx'
import { sessionAgentLabel } from '../thread/ThreadView.tsx'
import type { ProviderInstance } from '@beddcode/contracts'

const claude = {
  id: 'claude',
  kind: 'claude',
  label: 'Claude',
  status: 'ready',
} as ProviderInstance

describe('Claude backend', () => {
  it('shows the project backend control', () => {
    const html = renderToStaticMarkup(<ClaudeBackendSettings hostKey="host" projects={[]} online />)
    expect(html).toContain('Host Claude backend')
    expect(html).toContain('claude-host-backend')
    expect(html).toContain('Project Claude backend')
    expect(html).toContain('Use host default')
    expect(html).toContain('claude-project-backend')
  })
  it('uses the project override or the host default for the picker', () => {
    expect(effectiveClaudeBackend(undefined, 'cli')).toBe('cli')
    expect(effectiveClaudeBackend('sdk', 'cli')).toBe('sdk')
    expect(effectiveClaudeBackend('cli', 'sdk')).toBe('cli')
  })
  it('labels the running session for its effective backend', () => {
    expect(sessionAgentLabel(claude, 'cli')).toBe('Claude (CLI)')
    expect(sessionAgentLabel(claude, 'sdk')).toBe('Claude')
  })
  it('labels Claude when the effective backend uses CLI', () => {
    const render = (backend: 'cli' | 'sdk') =>
      renderToStaticMarkup(
        <AgentChip agents={[claude]} current={claude} claudeBackend={backend} onPick={() => {}} />,
      )
    expect(render('cli')).toContain('Claude (CLI)')
    expect(render('sdk')).not.toContain('Claude (CLI)')
  })
})
