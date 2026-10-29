import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrandIcon } from './BrandIcon.tsx'
import { BRAND_ICONS, type BrandId } from './brandIconData.ts'
import { AgentIcon } from './AgentMark.tsx'
import { EditorIcon, editorBrand } from '../features/editors/EditorIcon.tsx'

describe('brand icons', () => {
  it('every icon has a viewBox, markup without titles or scripts, and a license', () => {
    for (const [id, icon] of Object.entries(BRAND_ICONS)) {
      expect(icon.viewBox, id).toMatch(/^[\d.\s-]+$/)
      expect(icon.body, id).not.toMatch(/<title|<script|on[a-z]+=|href=/i)
      expect(icon.license, id).toBeTruthy()
    }
  })

  it('gives each copy its own ids, so gradients and masks never collide', () => {
    const one = renderToStaticMarkup(
      <>
        <BrandIcon brand="vscode" />
        <BrandIcon brand="vscode" />
      </>,
    )
    const ids = [...one.matchAll(/ id="([^"]+)"/g)].map((m) => m[1])
    expect(ids.length).toBeGreaterThan(1)
    expect(new Set(ids).size).toBe(ids.length)
    expect(one).not.toContain('__ID__')
    for (const ref of one.matchAll(/url\(#([^)]+)\)/g)) expect(ids).toContain(ref[1])
  })

  it('is decorative without a label and an image with one', () => {
    expect(renderToStaticMarkup(<BrandIcon brand="github" />)).toContain('aria-hidden="true"')
    const labelled = renderToStaticMarkup(<BrandIcon brand="github" label="GitHub" size={20} />)
    expect(labelled).toContain('role="img"')
    expect(labelled).toContain('aria-label="GitHub"')
    expect(labelled).toContain('width="20"')
  })

  it('draws the known agents and nothing for others', () => {
    expect(renderToStaticMarkup(<AgentIcon agent="acp:grok" />)).toContain('brand-grok')
    expect(renderToStaticMarkup(<AgentIcon agent="codex" />)).toContain('brand-codex')
    expect(renderToStaticMarkup(<AgentIcon agent="claude" labelled />)).toContain(
      'aria-label="Claude"',
    )
    expect(renderToStaticMarkup(<AgentIcon agent="acp:gemini" />)).toBe('')
  })

  it('maps editors and the file manager per system, with a generic fallback', () => {
    expect(editorBrand('vscode-insiders')).toBe<BrandId>('vscode')
    expect(editorBrand('rustrover')).toBe<BrandId>('jetbrains')
    expect(editorBrand('file-manager', 'darwin')).toBe<BrandId>('apple')
    expect(editorBrand('file-manager', 'win32')).toBe<BrandId>('windows')
    expect(editorBrand('file-manager', 'linux')).toBeUndefined()
    expect(editorBrand('some-new-editor')).toBeUndefined()
    expect(renderToStaticMarkup(<EditorIcon id="some-new-editor" />)).toContain('lucide')
    expect(renderToStaticMarkup(<EditorIcon id="zed" />)).toContain('brand-zed')
  })
})
