import { afterAll, describe, expect, it } from 'vitest'
import { meshTransfers } from '../worker/messages.ts'
import { edgeRefFromMesh } from './topologyRefs.ts'
import type { MeshBuffer, Profile2D, ShapeResult } from './types.ts'

const rectangle: Profile2D = {
  plane: 'XY',
  points: [
    [0, 0],
    [10, 0],
    [10, 4],
    [0, 4],
  ],
}

function reasonOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/g, ' ').slice(0, 180)
}

describe('mesh buffer transfers', () => {
  it('transfers the triangle buffers and the edge line buffer', () => {
    const edges = new Float32Array([0, 0, 0, 1, 0, 0])
    const shape: ShapeResult = {
      id: 's',
      bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      mesh: {
        positions: new Float32Array([0, 0, 0]),
        normals: new Float32Array([0, 0, 1]),
        indices: new Uint32Array([0]),
        faceGroups: [{ start: 0, count: 1, faceId: 7 }],
        edgeGroups: [{ start: 0, count: 2, edgeId: 9 }],
        edges: { positions: edges },
      },
    }
    const transfers = meshTransfers(shape)
    expect(transfers).toEqual([
      shape.mesh.positions.buffer,
      shape.mesh.normals.buffer,
      shape.mesh.indices.buffer,
      edges.buffer,
    ])
  })
})

const kernelModule = await import('./ReplicadKernel.ts').then(
  (mod) => ({ ok: true as const, mod }),
  (error: unknown) => ({ ok: false as const, reason: reasonOf(error) }),
)

if (!kernelModule.ok) {
  describe.skip(`OCCT WASM geometry (skipped: ${kernelModule.reason})`, () => {
    it('boxes, fillets, extrudes, and round-trips STEP', () => {})
  })
} else {
  const { ReplicadKernel, locateWasm } = kernelModule.mod
  const kernel = new ReplicadKernel()
  let skipReason: string | null = null
  try {
    await kernel.init()
  } catch (error) {
    skipReason = reasonOf(error)
    kernel.dispose()
  }

  describe('wasm path', () => {
    it('strips the Vitest /@fs prefix when running on node', () => {
      expect(locateWasm('/@fs/workspace/cad.wasm')).toBe('/workspace/cad.wasm')
      expect(locateWasm('/@fs/workspace/cad.wasm?import&url')).toBe('/workspace/cad.wasm')
      expect(locateWasm('./assets/cad.wasm')).toBe('./assets/cad.wasm')
      expect(locateWasm('./assets/cad.wasm?url')).toBe('./assets/cad.wasm')
    })
  })

  if (skipReason) {
    describe.skip(`OCCT WASM geometry (skipped: ${skipReason})`, () => {
      it('boxes, fillets, extrudes, and round-trips STEP', () => {})
    })
  } else {
    describe('OCCT WASM geometry', () => {
      afterAll(() => kernel.dispose())

      it('rounds only the four vertical edges of an 80 by 50 plate at radius 4', async () => {
        const plate = await kernel.createPrimitive('box', { width: 80, depth: 50, height: 8 }, 'largePlate')
        const picks = (plate.mesh.edgeGroups ?? []).flatMap((group) => {
          const ref = edgeRefFromMesh(plate.mesh, group)
          return ref && Math.abs(ref.dir[2]) > 0.99 && Math.abs(ref.length - 8) < 0.01
            ? [{ edgeId: group.edgeId, ref }]
            : []
        })
        expect(picks).toHaveLength(4)
        const ids = picks.map((pick) => pick.edgeId)
        const refs = picks.map((pick) => pick.ref)
        const rounded = await kernel.fillet('largePlate', 4, ids, refs, 'roundedPlate')
        const before = (await kernel.measure('largePlate')).volume
        const after = (await kernel.measure('roundedPlate')).volume
        expect(before - after).toBeCloseTo(4 * (16 - 4 * Math.PI) * 8, 2)
        expect(rounded.mesh.indices.length).toBeGreaterThan(plate.mesh.indices.length)
        const bevel = await kernel.chamfer('largePlate', 4, ids, refs, 'beveledPlate')
        expect(bevel.mesh.indices.length).toBeGreaterThan(0)
        expect(before - (await kernel.measure('beveledPlate')).volume).toBeCloseTo(4 * 8 * 8, 2)
      }, 120_000)

      it('fillets a box, extrudes a rectangle, and round-trips STEP', async () => {
        const box = await kernel.createPrimitive('box', { width: 10, depth: 20, height: 30 }, 'box')
        expect(box.mesh.positions.length).toBeGreaterThan(0)
        expect(box.mesh.faceGroups?.length).toBeGreaterThan(0)
        expect(box.mesh.edgeGroups?.length).toBeGreaterThan(0)
        const edgeLines = box.mesh.edges?.positions
        expect(edgeLines?.length).toBeGreaterThan(0)
        const groups = box.mesh.edgeGroups ?? []
        expect(groups.every((group) => group.start >= 0 && group.count >= 2)).toBe(true)
        const edgeId = groups[0]?.edgeId
        expect(typeof edgeId).toBe('number')

        const filleted = await kernel.fillet('box', 1, [edgeId!], undefined, 'filleted')
        expect(filleted.mesh.indices.length).toBeGreaterThan(0)
        const volume = (await kernel.measure('filleted')).volume
        expect(volume).toBeGreaterThan(0)
        const boxVolume = (await kernel.measure('box')).volume
        expect(volume).toBeLessThan(boxVolume)

        const extruded = await kernel.extrude(rectangle, 8, undefined, 'wall')
        expect(extruded.mesh.faceGroups?.length).toBeGreaterThan(0)
        const wall = await kernel.measure('wall')
        expect(wall.volume).toBeGreaterThan(0)

        const both = await kernel.extrude(rectangle, 8, { bothSides: true }, 'both')
        expect(both.mesh.edges?.positions.length).toBeGreaterThan(0)
        const bothVolume = (await kernel.measure('both')).volume
        expect(bothVolume).toBeGreaterThan(wall.volume)

        const bytes = await kernel.exportStep('box')
        expect(bytes.byteLength).toBeGreaterThan(0)
        const imported = await kernel.importStep(bytes, 'stepped')
        expect(imported.id).toBe('stepped')
        const again = await kernel.exportStep('stepped')
        expect(again.byteLength).toBeGreaterThan(0)
      }, 120_000)

      it('names a missing boolean target and a missing revolve profile', async () => {
        await expect(kernel.boolean('cut', 'gone', 'box')).rejects.toThrow(
          'boolean target gone is missing',
        )
        await expect(kernel.boolean('fuse', 'box', 'other')).rejects.toThrow(
          'boolean tool other is missing',
        )
        await expect(kernel.revolve(undefined as unknown as Profile2D, 90)).rejects.toThrow(
          'revolve profile is missing',
        )
        await expect(
          kernel.extrude(rectangle, 4, { cut: true, target: 'absent' }, 'pocket'),
        ).rejects.toThrow('extrude cut target absent is missing')
      }, 30_000)

      it('cuts a through hole and rematches a fillet after a small width change', async () => {
        const plate = await kernel.createPrimitive(
          'box',
          { width: 20, depth: 30, height: 10 },
          'plate',
        )
        const before = (await kernel.measure('plate')).volume
        expect(before).toBeGreaterThan(5000)

        const drilled = await kernel.hole(
          'plate',
          { origin: [0, 0, 10], diameter: 4, throughAll: true },
          'drilled',
        )
        expect(drilled.mesh.positions.length).toBeGreaterThan(0)
        const after = (await kernel.measure('drilled')).volume
        expect(after).toBeLessThan(before - 100)
        expect(after).toBeGreaterThan(before - 160)

        const counterbored = await kernel.hole(
          'plate',
          {
            origin: [4, 0, 10],
            diameter: 4,
            throughAll: true,
            counterbore: { diameter: 8, depth: 2 },
          },
          'counterbored',
        )
        const counterVolume = (await kernel.measure('counterbored')).volume
        expect(counterVolume).toBeLessThan(before - 180)
        expect(counterVolume).toBeGreaterThan(before - 250)

        const blind = await kernel.hole(
          'plate',
          { origin: [-4, 0, 10], diameter: 4, depth: 4 },
          'blind',
        )
        const blindVolume = (await kernel.measure('blind')).volume
        expect(blindVolume).toBeLessThan(before - 40)
        expect(blindVolume).toBeGreaterThan(before - 80)
        expect(blind.id).toBe('blind')

        const fromNormal = await kernel.hole(
          'plate',
          { origin: [0, 0, 10], direction: 'normal', diameter: 6, throughAll: true },
          'fromNormal',
        )
        const normalVolume = (await kernel.measure('fromNormal')).volume
        expect(normalVolume).toBeLessThan(before - 200)

        const picked = firstEdge(plate.mesh)
        expect(picked).not.toBeNull()
        const wider = await kernel.createPrimitive(
          'box',
          { width: 20.004, depth: 30, height: 10 },
          'wider',
        )
        const widerIds = new Set((wider.mesh.edgeGroups ?? []).map((group) => group.edgeId))
        expect(widerIds.has(picked!.edgeId)).toBe(false)
        const rounded = await kernel.fillet('wider', 1, [picked!.edgeId], [picked!.ref], 'rounded')
        expect(rounded.mesh.indices.length).toBeGreaterThan(0)
        const roundedVolume = (await kernel.measure('rounded')).volume
        const widerVolume = (await kernel.measure('wider')).volume
        expect(roundedVolume).toBeGreaterThan(0)
        expect(roundedVolume).toBeLessThan(widerVolume)

        await expect(
          kernel.fillet(
            'wider',
            0.4,
            [999999],
            [{ kind: 'edge', mid: [80, 80, 80], dir: [0, 0, 1], length: 10 }],
            'missed',
          ),
        ).rejects.toThrow(/fillet edges not found/)
      }, 120_000)
    })
  }
}

function firstEdge(
  mesh: MeshBuffer,
): { edgeId: number; ref: NonNullable<ReturnType<typeof edgeRefFromMesh>> } | null {
  for (const group of mesh.edgeGroups ?? []) {
    const ref = edgeRefFromMesh(mesh, group)
    if (ref) return { edgeId: group.edgeId, ref }
  }
  return null
}
