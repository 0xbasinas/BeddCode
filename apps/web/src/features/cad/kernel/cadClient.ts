import { exactBuffer } from './buffers'
import type { GeometryKernel } from './GeometryKernel'
import type {
  AxisName,
  BooleanMode,
  FeatureDocument,
  MeasureResult,
  PrimitiveKind,
  PrimitiveParams,
  Profile2D,
  ShapeResult,
} from './types'
import type { CadRequest, CadResponse } from '../worker/messages'

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never
type RequestBody = WithoutId<CadRequest>

function copyBytes(bytes: Uint8Array): Uint8Array {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy
}

/**
 * Main-thread GeometryKernel. Work runs in cadWorker so OpenCascade WASM does
 * not block the pane. Mesh and file buffers are transferred, not copied twice.
 */
export function createCadClient(): GeometryKernel {
  const worker = new Worker(new URL('../worker/cadWorker.ts', import.meta.url), { type: 'module' })
  let nextId = 1
  let dead = false
  let ready: Promise<void> | null = null
  const pending = new Map<number, { resolve: (response: CadResponse & { ok: true }) => void; reject: (error: Error) => void }>()

  const failAll = (error: Error) => {
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }

  worker.onmessage = (event: MessageEvent<CadResponse>) => {
    const response = event.data
    const waiter = pending.get(response.id)
    if (!waiter) return
    pending.delete(response.id)
    if (response.ok) waiter.resolve(response)
    else waiter.reject(new Error(response.error))
  }
  worker.onerror = () => failAll(new Error('cad worker failed'))

  function send(request: RequestBody, transfer: ArrayBuffer[] = []): Promise<CadResponse & { ok: true }> {
    if (dead) return Promise.reject(new Error('kernel disposed'))
    const id = nextId++
    const message = { ...request, id } as CadRequest
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      if (transfer.length) worker.postMessage(message, transfer)
      else worker.postMessage(message)
    })
  }

  function shapeOf(response: CadResponse & { ok: true }): ShapeResult {
    if (response.type !== 'shape') throw new Error('cad worker returned no shape')
    return response.shape
  }

  const client: GeometryKernel = {
    init() {
      if (!ready) ready = send({ kind: 'init' }).then(() => undefined)
      return ready
    },
    async createPrimitive(kind: PrimitiveKind, params: PrimitiveParams) {
      await client.init()
      return shapeOf(await send({ kind: 'createPrimitive', primitive: kind, params }))
    },
    async extrude(profile: Profile2D, distance: number) {
      await client.init()
      return shapeOf(await send({ kind: 'extrude', profile, distance }))
    },
    async revolve(profile: Profile2D, angle: number, axis?: AxisName) {
      await client.init()
      return shapeOf(await send({ kind: 'revolve', profile, angle, axis }))
    },
    async fillet(targetId: string, radius: number) {
      await client.init()
      return shapeOf(await send({ kind: 'fillet', targetId, radius }))
    },
    async chamfer(targetId: string, radius: number) {
      await client.init()
      return shapeOf(await send({ kind: 'chamfer', targetId, radius }))
    },
    async boolean(mode: BooleanMode, targetId: string, toolId: string) {
      await client.init()
      return shapeOf(await send({ kind: 'boolean', mode, targetId, toolId }))
    },
    async measure(targetId: string): Promise<MeasureResult> {
      await client.init()
      const response = await send({ kind: 'measure', targetId })
      if (response.type !== 'measure') throw new Error('cad worker returned no measure')
      return response.measure
    },
    async importStep(bytes: Uint8Array) {
      await client.init()
      const payload = exactBuffer(copyBytes(bytes))
      return shapeOf(await send({ kind: 'importStep', bytes: payload }, [payload]))
    },
    async exportStep(targetId: string) {
      await client.init()
      const response = await send({ kind: 'exportStep', targetId })
      if (response.type !== 'bytes') throw new Error('cad worker returned no file')
      return new Uint8Array(response.bytes)
    },
    async exportStl(targetId: string) {
      await client.init()
      const response = await send({ kind: 'exportStl', targetId })
      if (response.type !== 'bytes') throw new Error('cad worker returned no file')
      return new Uint8Array(response.bytes)
    },
    async rebuild(document: FeatureDocument, files: Readonly<Record<string, Uint8Array>> = {}) {
      await client.init()
      const payload = Object.entries(files).map(([id, bytes]) => ({ id, bytes: exactBuffer(copyBytes(bytes)) }))
      const response = await send(
        { kind: 'rebuild', document, files: payload.map(({ id, bytes }) => ({ id, bytes })) },
        payload.map((file) => file.bytes),
      )
      if (response.type !== 'shapes') throw new Error('cad worker returned no shapes')
      return response.shapes
    },
    dispose() {
      dead = true
      ready = null
      failAll(new Error('kernel disposed'))
      worker.postMessage({ id: 0, kind: 'dispose' })
      worker.terminate()
    },
  }

  return client
}
