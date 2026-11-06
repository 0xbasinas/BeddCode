import { describe, expect, it } from 'vitest'
import {
  addAnnotation,
  hitAnnotation,
  pruneAnnotations,
  removeAnnotation,
  type Annotation,
} from './annotations.ts'

const flange: Annotation = {
  id: 'measure-a',
  featureId: 'a',
  title: 'Flange',
  lines: ['Volume 12', 'Area 44'],
}

const boss: Annotation = {
  id: 'measure-b',
  featureId: 'b',
  title: 'Boss',
  lines: ['Volume 3'],
}

describe('addAnnotation', () => {
  it('appends a new measurement', () => {
    expect(addAnnotation([], flange)).toEqual([flange])
  })

  it('replaces an earlier measurement of the same feature', () => {
    const updated = { ...flange, lines: ['Volume 99'] }
    const list = addAnnotation([flange, boss], updated)
    expect(list).toHaveLength(2)
    expect(list.find((item) => item.featureId === 'a')?.lines).toEqual(['Volume 99'])
  })

  it('keeps the other features in place', () => {
    const list = addAnnotation([flange], boss)
    expect(list.map((item) => item.featureId)).toEqual(['a', 'b'])
  })
})

describe('removeAnnotation', () => {
  it('drops one by id', () => {
    expect(removeAnnotation([flange, boss], 'measure-a')).toEqual([boss])
  })

  it('is a no-op for an unknown id', () => {
    expect(removeAnnotation([flange], 'nope')).toEqual([flange])
  })
})

describe('pruneAnnotations', () => {
  it('drops measurements whose feature is gone', () => {
    const live = new Set(['a'])
    expect(pruneAnnotations([flange, boss], live)).toEqual([flange])
  })

  it('returns the same list when nothing changed', () => {
    const list = [flange]
    expect(pruneAnnotations(list, new Set(['a']))).toBe(list)
  })

  it('empties the list when every feature is gone', () => {
    expect(pruneAnnotations([flange, boss], new Set())).toEqual([])
  })
})

describe('hitAnnotation', () => {
  const placed = { 'measure-a': { x: 10, y: 10 }, 'measure-b': { x: 100, y: 100 } }

  it('finds the card under the pointer', () => {
    expect(hitAnnotation([flange, boss], { x: 12, y: 11 }, placed, 8)?.id).toBe('measure-a')
  })

  it('returns null when nothing is within reach', () => {
    expect(hitAnnotation([flange, boss], { x: 50, y: 50 }, placed, 8)).toBeNull()
  })

  it('ignores cards with no measured screen position', () => {
    expect(hitAnnotation([flange], { x: 0, y: 0 }, {}, 100)).toBeNull()
  })

  it('prefers the closer of two cards in range', () => {
    const near = { 'measure-a': { x: 10, y: 10 }, 'measure-b': { x: 14, y: 10 } }
    expect(hitAnnotation([flange, boss], { x: 13, y: 10 }, near, 8)?.id).toBe('measure-b')
  })
})
