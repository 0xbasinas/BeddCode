// Copyright 2023 QuaroTech Sàrl — MIT License (see LICENSE)
// Vendored and adapted for BeddCode from https://github.com/sgenoud/replicad
// @ts-nocheck

import {
  approximateAsSvgCompatibleCurve,
  ApproximationOptions,
} from "../lib2d";
import Blueprint from "./Blueprint";
import Blueprints from "./Blueprints";
import { Shape2D } from "./boolean2D";
import CompoundBlueprint from "./CompoundBlueprint";

export function approximateForSVG<T extends Shape2D>(
  bp: T,
  options: ApproximationOptions
): T {
  if (bp instanceof Blueprint) {
    return new Blueprint(
      approximateAsSvgCompatibleCurve(bp.curves, options)
    ) as T;
  } else if (bp instanceof CompoundBlueprint) {
    return new CompoundBlueprint(
      bp.blueprints.map((b) => approximateForSVG(b, options))
    ) as T;
  } else if (bp instanceof Blueprints) {
    return new Blueprints(
      bp.blueprints.map((b) => approximateForSVG(b, options))
    ) as T;
  }
  return bp;
}
