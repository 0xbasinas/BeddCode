import { useEffect, useRef, useState } from 'react'
import { createCadClient } from './kernel/cadClient.ts'
import type { GeometryKernel } from './kernel/GeometryKernel.ts'
import type { FeatureOp, ShapeResult } from './kernel/types.ts'
import type { CadDocument } from './model/CadDocument.ts'
import { ownerId, toFeatureDocument, visibleShapeIds } from './model/toFeatureDocument.ts'
import type { MeshBuffers } from './solids.ts'

export interface CadRebuild {
  meshes: MeshBuffers[]
  errors: Record<string, string>
  loading: boolean
  failure: string | null
  getClient(): GeometryKernel
}

/**
 * One OpenCascade client for the pane. Rebuild replays the document.
 * The worker kernel keeps shapes and rejects a second replay of the same ids,
 * so a used client is replaced before the next rebuild.
 */
export function useCadRebuild(
  doc: CadDocument,
  stepFiles: Readonly<Record<string, Uint8Array>>,
): CadRebuild {
  const clientRef = useRef<GeometryKernel | null>(null)
  const dirtyRef = useRef(false)
  const generation = useRef(0)
  const filesRef = useRef(stepFiles)
  filesRef.current = stepFiles
  const [meshes, setMeshes] = useState<MeshBuffers[]>([])
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const booted = useRef(false)

  const getClient = (): GeometryKernel => {
    if (!clientRef.current) clientRef.current = createCadClient()
    return clientRef.current
  }

  const recycle = (): GeometryKernel => {
    clientRef.current?.dispose()
    dirtyRef.current = false
    const next = createCadClient()
    clientRef.current = next
    return next
  }

  useEffect(() => {
    getClient()
    return () => {
      generation.current += 1
      clientRef.current?.dispose()
      clientRef.current = null
      dirtyRef.current = false
    }
  }, [])

  useEffect(() => {
    const gen = generation.current + 1
    generation.current = gen
    const timer = setTimeout(() => {
      void replay(doc, filesRef.current, gen)
    }, 40)
    return () => {
      clearTimeout(timer)
    }
    // filesRef is read inside the timer so a new byte map still retriggers via stepFiles.
  }, [doc, stepFiles])

  async function replay(
    current: CadDocument,
    files: Readonly<Record<string, Uint8Array>>,
    gen: number,
  ): Promise<void> {
    const still = () => generation.current === gen
    const plan = toFeatureDocument(current, files)
    if (!booted.current) setLoading(true)
    let client = getClient()
    if (dirtyRef.current) client = recycle()
    let pending = plan.document.ops
    let duplicateRetries = 0
    const kernelErrors: Record<string, string> = {}

    while (still()) {
      try {
        const shapes = await client.rebuild({ version: 1, ops: pending }, plan.files)
        if (!still()) return
        dirtyRef.current = true
        booted.current = true
        setLoading(false)
        setFailure(null)
        setErrors({ ...plan.errors, ...kernelErrors })
        setMeshes(meshesFrom(shapes, pending))
        return
      } catch (error) {
        if (!still()) return
        const message = error instanceof Error ? error.message : String(error)
        if (/duplicate feature id/.test(message) && duplicateRetries < 1) {
          duplicateRetries += 1
          client = recycle()
          continue
        }
        duplicateRetries = 0
        dirtyRef.current = true
        if (pending.length === 0) {
          booted.current = true
          setLoading(false)
          setFailure(message)
          setErrors({ ...plan.errors, ...kernelErrors })
          setMeshes([])
          return
        }
        const blame = blameFeature(message, pending)
        kernelErrors[blame] = message
        const peeled = opsBefore(pending, blame)
        pending = peeled.length < pending.length ? peeled : pending.slice(0, -1)
        client = recycle()
        if (pending.length === 0) {
          booted.current = true
          setLoading(false)
          setFailure(message)
          setErrors({ ...plan.errors, ...kernelErrors })
          setMeshes([])
          return
        }
      }
    }
  }

  return { meshes, errors, loading, failure, getClient }
}

function meshesFrom(shapes: ShapeResult[], ops: readonly FeatureOp[]): MeshBuffers[] {
  const visible = new Set(visibleShapeIds(ops))
  const meshes: MeshBuffers[] = []
  for (const shape of shapes) {
    if (!visible.has(shape.id)) continue
    meshes.push(meshOf(shape))
  }
  return meshes
}

function meshOf(shape: ShapeResult): MeshBuffers {
  const raw = shape.mesh as ShapeResult['mesh'] & {
    faceGroups?: MeshBuffers['faceGroups']
    edgeGroups?: MeshBuffers['edgeGroups']
    edges?: MeshBuffers['edges']
  }
  const mesh: MeshBuffers = {
    id: shape.id,
    positions: raw.positions,
    normals: raw.normals,
    indices: raw.indices,
  }
  if (raw.faceGroups) mesh.faceGroups = raw.faceGroups
  if (raw.edgeGroups) mesh.edgeGroups = raw.edgeGroups
  if (raw.edges) {
    mesh.edges = raw.edges
    mesh.edgePositions = raw.edges.positions
  }
  return mesh
}

function blameFeature(message: string, ops: readonly FeatureOp[]): string {
  for (let index = ops.length - 1; index >= 0; index -= 1) {
    const op = ops[index]
    if (!op) continue
    const owner = ownerId(op.id)
    if (message.includes(op.id) || message.includes(owner)) return owner
  }
  const last = ops[ops.length - 1]
  return last ? ownerId(last.id) : 'rebuild'
}

function opsBefore(ops: readonly FeatureOp[], featureId: string): FeatureOp[] {
  const prefix: FeatureOp[] = []
  for (const op of ops) {
    if (ownerId(op.id) === featureId) break
    prefix.push(op)
  }
  return prefix
}
