import { describe, expect, it } from 'vitest'
import { MAX_PANES, dropEdge, loadSide, placeSession } from './splitLayout.ts'

describe('placeSession', () => {
  it('opens a session alone when nothing shows', () => {
    expect(placeSession([], 'a', { index: 0, edge: 'center' })).toEqual(['a'])
    expect(placeSession([], 'a', { index: 0, edge: 'right' })).toEqual(['a'])
  })

  it('opens beside a pane on its right or left edge', () => {
    expect(placeSession(['a'], 'b', { index: 0, edge: 'right' })).toEqual(['a', 'b'])
    expect(placeSession(['a'], 'b', { index: 0, edge: 'left' })).toEqual(['b', 'a'])
    expect(placeSession(['a', 'b'], 'c', { index: 0, edge: 'right' })).toEqual(['a', 'c', 'b'])
  })

  it('replaces the pane it is dropped in the middle of', () => {
    expect(placeSession(['a', 'b'], 'c', { index: 1, edge: 'center' })).toEqual(['a', 'c'])
    expect(placeSession(['a', 'b'], 'c', { index: 0, edge: 'center' })).toEqual(['c', 'b'])
  })

  it('moves a session that already shows instead of showing it twice', () => {
    expect(placeSession(['a', 'b'], 'b', { index: 0, edge: 'left' })).toEqual(['b', 'a'])
    expect(placeSession(['a', 'b', 'c'], 'a', { index: 2, edge: 'right' })).toEqual(['b', 'c', 'a'])
    expect(placeSession(['a', 'b'], 'a', { index: 1, edge: 'center' })).toEqual(['a'])
    // Onto itself: nothing changes.
    expect(placeSession(['a', 'b'], 'b', { index: 1, edge: 'right' })).toEqual(['a', 'b'])
  })

  it(`keeps at most ${MAX_PANES} panes, letting go of the one furthest from the drop`, () => {
    expect(placeSession(['a', 'b', 'c'], 'd', { index: 2, edge: 'right' })).toEqual(['b', 'c', 'd'])
    expect(placeSession(['a', 'b', 'c'], 'd', { index: 0, edge: 'left' })).toEqual(['d', 'a', 'b'])
  })
})

describe('dropEdge', () => {
  it('splits on the outer quarters and replaces in the middle', () => {
    expect(dropEdge(110, 100, 400)).toBe('left')
    expect(dropEdge(300, 100, 400)).toBe('center')
    expect(dropEdge(490, 100, 400)).toBe('right')
    expect(dropEdge(5, 0, 0)).toBe('center')
  })
})

describe('loadSide', () => {
  const store = (value: string | null) => ({ getItem: () => value, setItem: () => {} })
  it('restores the side panes, without repeats or junk', () => {
    expect(loadSide(store('["a","a",3,"","b","c"]'))).toEqual(['a', 'b'])
    expect(loadSide(store('{"x":1}'))).toEqual([])
    expect(loadSide(store('not json'))).toEqual([])
    expect(loadSide(store(null))).toEqual([])
  })
})
