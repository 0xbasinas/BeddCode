import { describe, expect, it } from 'vitest'
import { parsePairLink } from '@beddcode/client-runtime/pairLink'
import { buildRelayRoute } from '@beddcode/client-runtime/relaySocket'
import { createPairing, PairingManager } from './pairing.ts'

describe('createPairing', () => {
  it('links the code to the addresses and the relay route', async () => {
    const relay = buildRelayRoute('wss://relay.example.workers.dev', 'A'.repeat(43))
    const pair = await createPairing(new PairingManager(), async () => ({
      hostId: 'h1',
      name: 'devbox',
      routes: ['ws://10.0.0.5:3773/ws'],
      relay,
    }))
    const link = parsePairLink(pair.link ?? '')
    expect(link?.code).toBe(pair.code)
    expect(link?.name).toBe('devbox')
    expect(link?.relay).toBe(relay)
  })

  it('still hands out a code when the addresses cannot be read', async () => {
    const pair = await createPairing(new PairingManager(), async () => {
      throw new Error('no network')
    })
    expect(pair.code).toMatch(/^\d{6}$/)
    expect(pair.link).toBeUndefined()
  })
})
