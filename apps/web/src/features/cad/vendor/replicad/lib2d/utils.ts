// Copyright 2023 QuaroTech Sàrl — MIT License (see LICENSE)
// Vendored and adapted for BeddCode from https://github.com/sgenoud/replicad
// @ts-nocheck

import round2 from '../utils/round2'
import type { Point2D } from './definitions'

export const reprPnt = ([x, y]: Point2D): string => {
  return `(${round2(x)},${round2(y)})`
}

const asFixed = (p: number, precision = 1e-9): string => {
  let num = p
  if (Math.abs(p) < precision) num = 0
  return num.toFixed(-Math.log10(precision))
}
export const removeDuplicatePoints = (points: Point2D[], precision = 1e-9): Point2D[] => {
  return Array.from(
    new Map(
      points.map(([p0, p1]) => [
        `[${asFixed(p0, precision)},${asFixed(p1, precision)}]`,
        [p0, p1] as Point2D,
      ]),
    ).values(),
  )
}
