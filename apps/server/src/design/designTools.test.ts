import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DesignStore, type DesignChange } from './designStore.ts'
import { DesignTools } from './designTools.ts'
import { DesignLink } from './designLink.ts'
import type { ServerFrame } from '@beddcode/contracts'

let dir: string
let store: DesignStore
let tools: DesignTools
let changes: DesignChange[]
let link: DesignLink

const run = (tool: Parameters<DesignTools['call']>[0], args: Record<string, unknown> = {}) => {
  const r = tools.call(tool, args)
  const first = r.content[0]!
  const text = first.type === 'text' ? first.text : ''
  return { error: r.isError === true, text, json: r.isError ? undefined : (() => { try { return JSON.parse(text) } catch { return undefined } })() }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'designs-'))
  store = new DesignStore(dir)
  link = new DesignLink()
  tools = new DesignTools(store, link)
  changes = []
  store.onChange((c) => changes.push(c))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('design tools', () => {
  it('tells listeners which elements an agent touched', () => {
    run('design_add', { elements: [{ type: 'frame', children: [{ type: 'ellipse' }] }] })
    const added = changes.at(-1)!.touched!
    expect(added).toHaveLength(2)
    run('design_update', { updates: [{ id: added[1], x: 5 }] })
    expect(changes.at(-1)!.touched).toEqual([added[1]])
  })

  it('reports what the user has selected in an open Design screen', () => {
    expect(run('design_get_selection').text).toMatch(/Nothing is open/)
    run('design_add', { elements: [{ type: 'rectangle', name: 'Box' }] })
    const read = run('design_read').json
    const sent: ServerFrame[] = []
    const client = link.connect((f) => sent.push(f))
    client.frame({ t: 'design.view', canRender: true, designId: read.design, selection: [read.elements[0].id] })
    expect(run('design_get_selection').json.selected[0]).toMatchObject({ name: 'Box' })
  })

  it('asks a connected app for a picture and returns it', async () => {
    run('design_add', { elements: [{ type: 'rectangle' }] })
    expect((await tools.callAsync('design_screenshot', {})).content[0]).toMatchObject({
      text: expect.stringMatching(/No BeddCode app/),
    })
    const sent: ServerFrame[] = []
    const client = link.connect((f) => sent.push(f))
    client.frame({ t: 'design.view', canRender: true })
    const pending = tools.callAsync('design_screenshot', { scale: 5 })
    const asked = sent.find((f) => f.t === 'design.render')!
    expect(asked).toMatchObject({ t: 'design.render', scale: 2 })
    client.frame({ t: 'design.rendered', id: (asked as { id: string }).id, image: { data: 'QUJD', mime: 'image/png' } })
    const result = await pending
    expect(result.isError).toBeUndefined()
    expect(result.content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/png' })
  })

  it('creates a design on first use and draws nested elements into it', () => {
    const added = run('design_add', {
      elements: [
        {
          type: 'frame',
          name: 'Card',
          width: 300,
          height: 200,
          children: [
            { type: 'rectangle', x: 10, y: 10, width: 50, height: 50, fill: '#ff0000' },
            { type: 'text', x: 10, y: 80, textContent: 'Hello', fontSize: 20 },
          ],
        },
      ],
    })
    expect(added.error).toBe(false)
    const read = run('design_read').json
    expect(read.elements).toHaveLength(1)
    const card = read.elements[0]
    expect(card).toMatchObject({ type: 'frame', name: 'Card', width: 300, fill: '#FFFFFF' })
    expect(card.children.map((c: { type: string }) => c.type)).toEqual(['rectangle', 'text'])
    expect(card.children[1]).toMatchObject({ text: 'Hello', fontSize: 20 })
    expect(changes.at(-1)).toMatchObject({ origin: 'agent' })
  })

  it('updates and removes elements by id, anywhere in the tree', () => {
    run('design_add', {
      elements: [{ type: 'frame', children: [{ type: 'ellipse', name: 'Dot' }] }],
    })
    const tree = run('design_read').json.elements[0]
    const dot = tree.children[0].id
    expect(run('design_update', { updates: [{ id: dot, x: 40, fill: '#00ff00', type: 'text' }] }).error).toBe(false)
    const after = run('design_read').json.elements[0].children[0]
    expect(after).toMatchObject({ type: 'ellipse', x: 40, fill: '#00ff00' })
    expect(run('design_remove', { ids: [dot] }).json.removed).toBe(1)
    expect(run('design_read').json.elements[0].children).toBeUndefined()
  })

  it('refuses what it cannot do, in words an agent can act on', () => {
    expect(run('design_add', { elements: [{ type: 'banana' }] }).text).toMatch(/Unknown element type/)
    expect(run('design_add', { elements: [{ type: 'rectangle', children: [{ type: 'text' }] }] }).text).toMatch(
      /cannot have children/,
    )
    expect(run('design_read', { design: 'nope' }).text).toMatch(/No design nope/)
    const rect = run('design_add', { elements: [{ type: 'rectangle' }] }).json.added[0]
    expect(run('design_add', { parent: rect, elements: [{ type: 'text' }] }).text).toMatch(/not a frame or group/)
    expect(run('design_update', { updates: [{ id: 'ghost', x: 1 }] }).text).toMatch(/No element with id ghost/)
  })

  it('drops fields outside the whitelist and keeps pages apart', () => {
    const page = run('design_add_page', { name: 'Two' }).json.page
    run('design_add', { page, elements: [{ type: 'rectangle', evil: 'x', __proto__: { a: 1 } }] })
    const second = run('design_read', { page }).json
    expect(second.elements).toHaveLength(1)
    expect(Object.keys(store.get(second.design)!.project.pages as object)).toBeTruthy()
    const raw = (store.get(second.design)!.project.pages as { elements: Record<string, unknown>[] }[])[1]!.elements[0]!
    expect(raw).not.toHaveProperty('evil')
    expect(run('design_read').json.elements).toHaveLength(0)
    expect(run('design_read').json.pages).toHaveLength(2)
  })

  it('persists across store instances and bumps rev on each save', () => {
    const id = run('design_create', { name: 'Poster' }).json.id
    run('design_add', { design: id, elements: [{ type: 'star' }] })
    const reopened = new DesignStore(dir)
    expect(reopened.get(id)).toMatchObject({ name: 'Poster', rev: 2 })
    expect(reopened.list().map((d) => d.id)).toEqual([id])
  })

  it('saves whole projects from the editor and rejects unsafe ids', () => {
    const d = store.create('A')
    const saved = store.save(d.id, { name: 'Renamed', pages: [], activePageId: 'x' }, 'tab-1')
    expect(saved).toMatchObject({ name: 'Renamed', rev: 2 })
    expect(changes.at(-1)).toEqual({ id: d.id, rev: 2, origin: 'tab-1' })
    expect(store.get('../etc/passwd')).toBeUndefined()
    expect(() => store.save('../etc/passwd', {})).toThrow(/No design/)
    expect(store.remove('../etc/passwd')).toBe(false)
  })
})
