import { exactBuffer } from '../kernel/buffers'
import { ReplicadKernel } from '../kernel/ReplicadKernel'
import { responseTransfers } from './messages'
import type { CadRequest, CadResponse } from './messages'

// Module workers share the page origin. DOM lib does not type `self` as a worker.
interface WorkerScope {
  onmessage: ((event: MessageEvent<CadRequest>) => void) | null
  postMessage(message: CadResponse, transfer?: Transferable[]): void
}

const scope = self as unknown as WorkerScope

let kernel: ReplicadKernel | null = null
let starting: Promise<void> | null = null

function readyKernel(): Promise<ReplicadKernel> {
  if (!kernel) kernel = new ReplicadKernel()
  if (!starting) {
    const current = kernel
    starting = current.init().catch((error: unknown) => {
      starting = null
      throw error
    })
  }
  return starting.then(() => {
    if (!kernel) throw new Error('geometry kernel is not initialised')
    return kernel
  })
}

function reply(response: CadResponse): void {
  const transfers = responseTransfers(response)
  if (transfers.length) scope.postMessage(response, transfers)
  else scope.postMessage(response)
}

async function dispatch(request: CadRequest): Promise<void> {
  try {
    // WASM is compiled on the first message, not when the worker script loads.
    const cad = await readyKernel()
    switch (request.kind) {
      case 'init':
        reply({ id: request.id, ok: true, type: 'ready' })
        return
      case 'dispose':
        cad.dispose()
        reply({ id: request.id, ok: true, type: 'disposed' })
        return
      case 'createPrimitive':
        reply({
          id: request.id,
          ok: true,
          type: 'shape',
          shape: await cad.createPrimitive(request.primitive, request.params),
        })
        return
      case 'extrude':
        reply({
          id: request.id,
          ok: true,
          type: 'shape',
          shape: await cad.extrude(request.profile, request.distance),
        })
        return
      case 'revolve':
        reply({
          id: request.id,
          ok: true,
          type: 'shape',
          shape: await cad.revolve(request.profile, request.angle, request.axis),
        })
        return
      case 'fillet':
        reply({
          id: request.id,
          ok: true,
          type: 'shape',
          shape: await cad.fillet(request.targetId, request.radius),
        })
        return
      case 'chamfer':
        reply({
          id: request.id,
          ok: true,
          type: 'shape',
          shape: await cad.chamfer(request.targetId, request.radius),
        })
        return
      case 'boolean':
        reply({
          id: request.id,
          ok: true,
          type: 'shape',
          shape: await cad.boolean(request.mode, request.targetId, request.toolId),
        })
        return
      case 'measure':
        reply({
          id: request.id,
          ok: true,
          type: 'measure',
          measure: await cad.measure(request.targetId),
        })
        return
      case 'importStep':
        reply({
          id: request.id,
          ok: true,
          type: 'shape',
          shape: await cad.importStep(new Uint8Array(request.bytes)),
        })
        return
      case 'exportStep':
        reply({
          id: request.id,
          ok: true,
          type: 'bytes',
          bytes: exactBuffer(await cad.exportStep(request.targetId)),
        })
        return
      case 'exportStl':
        reply({
          id: request.id,
          ok: true,
          type: 'bytes',
          bytes: exactBuffer(await cad.exportStl(request.targetId)),
        })
        return
      case 'rebuild': {
        const files: Record<string, Uint8Array> = {}
        for (const file of request.files) files[file.id] = new Uint8Array(file.bytes)
        reply({
          id: request.id,
          ok: true,
          type: 'shapes',
          shapes: await cad.rebuild(request.document, files),
        })
        return
      }
      default:
        reply({ id: (request as CadRequest).id, ok: false, error: 'unknown cad request' })
    }
  } catch (error) {
    reply({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

let chain: Promise<void> = Promise.resolve()
scope.onmessage = (event) => {
  chain = chain.then(() => dispatch(event.data))
}
