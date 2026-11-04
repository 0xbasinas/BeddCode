import type { EventStore, PeerDelivery } from '../store/eventStore.ts'

type Wake = (message: PeerDelivery) => void

/** Complete the durable handoff, then let the session manager run its existing prompt queue. */
export function deliverPeer(store: EventStore, message: PeerDelivery, wake: Wake): void {
  store.deliverPeerMessage(message)
  wake(message)
}

/** Also wake delivered entries: the host may have stopped after marking but before waking. */
export function recoverPeerDeliveries(
  store: EventStore,
  wake: Wake,
  onError: (error: unknown) => void,
): void {
  for (const message of store.peerDeliveries()) {
    try {
      deliverPeer(store, message, wake)
    } catch (error) {
      onError(error)
    }
  }
}
