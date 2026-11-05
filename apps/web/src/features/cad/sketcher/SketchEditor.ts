import { solveSketch } from './solve.ts'
import type {
  Sketch,
  SketchConstraint,
  SketchConstraintDraft,
  SketchDimension,
  SketchDimensionDraft,
  SketchEntity,
  SketchEntityDraft,
  SketchPlane,
} from './types.ts'

export interface SketchEditorOptions {
  id?: string
  name?: string
  plane?: SketchPlane
}

/**
 * Adds entities, constraints, and dimensions, then evaluates them.
 * Evaluation stores the solved geometry back on the editor.
 */
export class SketchEditor {
  private sketch: Sketch
  private next = 1

  constructor(options: SketchEditorOptions = {}) {
    this.sketch = {
      id: options.id ?? 'sketch',
      name: options.name ?? 'Sketch',
      plane: options.plane ?? 'XY',
      entities: [],
      constraints: [],
      dimensions: [],
    }
  }

  static from(sketch: Sketch): SketchEditor {
    const editor = new SketchEditor({ id: sketch.id, name: sketch.name, plane: sketch.plane })
    editor.sketch = {
      ...sketch,
      entities: sketch.entities.map((entity) => ({ ...entity })),
      constraints: sketch.constraints.map((constraint) => ({ ...constraint })),
      dimensions: sketch.dimensions.map((dimension) => ({ ...dimension })),
    }
    editor.next = sketch.entities.length + sketch.constraints.length + sketch.dimensions.length + 1
    return editor
  }

  addEntity(draft: SketchEntityDraft & { id?: string }): SketchEntity {
    const entity = { ...draft, id: draft.id ?? this.allocate('e') } as SketchEntity
    this.sketch = { ...this.sketch, entities: [...this.sketch.entities, entity] }
    return entity
  }

  addConstraint(draft: SketchConstraintDraft & { id?: string }): SketchConstraint {
    const constraint = { ...draft, id: draft.id ?? this.allocate('c') } as SketchConstraint
    this.sketch = { ...this.sketch, constraints: [...this.sketch.constraints, constraint] }
    return constraint
  }

  addDimension(draft: SketchDimensionDraft & { id?: string }): SketchDimension {
    const dimension = { ...draft, id: draft.id ?? this.allocate('d') } as SketchDimension
    this.sketch = { ...this.sketch, dimensions: [...this.sketch.dimensions, dimension] }
    return dimension
  }

  /** Solves the sketch and keeps the result. */
  evaluate(): Sketch {
    this.sketch = solveSketch(this.sketch)
    return this.getSketch()
  }

  getSketch(): Sketch {
    return {
      ...this.sketch,
      entities: this.sketch.entities.map((entity) => ({ ...entity })),
      constraints: this.sketch.constraints.map((constraint) => ({ ...constraint })),
      dimensions: this.sketch.dimensions.map((dimension) => ({ ...dimension })),
    }
  }

  private allocate(prefix: string): string {
    const id = `${prefix}${this.next}`
    this.next += 1
    return id
  }
}
