// Copyright 2023 QuaroTech Sàrl — MIT License (see LICENSE)
// Vendored and adapted for BeddCode from https://github.com/sgenoud/replicad
// @ts-nocheck

import Sketcher from './Sketcher'
import FaceSketcher, { BaseSketcher2d, BlueprintSketcher } from './Sketcher2d'

import { BoundingBox2d, Curve2D, axis2d } from './lib2d'
import type { Point2D } from './lib2d'
import type { GenericSketcher, SplineConfig } from './sketcherlib'

export { axis2d, Sketcher, BaseSketcher2d, FaceSketcher, BlueprintSketcher, BoundingBox2d, Curve2D }

export type { GenericSketcher, SplineConfig, Point2D }

export * from './constants'
export * from './oclib'
export * from './register'
export * from './geom'
export * from './geomHelpers'
export * from './shapes'
export * from './shapeInterfaces'
export * from './shapeHelpers'
export * from './measureShape'
export * from './finders'
export * from './shortcuts.js'
export * from './addThickness'
export * from './blueprints'
export * from './sketches'
export * from './importers'
export * from './draw'
export * from './projection'
// Text (opentype.js) and manifold mesh booleans are not vendored.
export * from './export/assemblyExporter'
