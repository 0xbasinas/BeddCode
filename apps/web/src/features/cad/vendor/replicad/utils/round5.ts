// Copyright 2023 QuaroTech Sàrl — MIT License (see LICENSE)
// Vendored and adapted for BeddCode from https://github.com/sgenoud/replicad
// @ts-nocheck

export default function round5(v: number): number {
  return Math.round(v * 100000) / 100000
}
