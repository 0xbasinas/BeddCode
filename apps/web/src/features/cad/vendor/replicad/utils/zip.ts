// Copyright 2023 QuaroTech Sàrl — MIT License (see LICENSE)
// Vendored and adapted for BeddCode from https://github.com/sgenoud/replicad
// @ts-nocheck

import range from './range'

export default function zip<T extends unknown[][]>(
  arrays: T,
): { [K in keyof T]: T[K] extends (infer V)[] ? V : never }[] {
  const minLength = Math.min(...arrays.map((arr) => arr.length))
  // @ts-expect-error This is too much for ts
  return range(minLength).map((i) => arrays.map((arr) => arr[i]))
}
