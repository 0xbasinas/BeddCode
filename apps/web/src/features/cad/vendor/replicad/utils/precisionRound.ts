// Copyright 2023 QuaroTech Sàrl — MIT License (see LICENSE)
// Vendored and adapted for BeddCode from https://github.com/sgenoud/replicad
// @ts-nocheck

// from https://stackoverflow.com/a/49729715
export default function precisionRound(number: number, precision: number) {
  const factor = Math.pow(10, precision)
  const n = precision < 0 ? number : 0.01 / factor + number
  return Math.round(n * factor) / factor
}
