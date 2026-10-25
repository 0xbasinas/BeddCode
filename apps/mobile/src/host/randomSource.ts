import { getRandomValues } from 'expo-crypto'

// React Native has no `crypto.getRandomValues`, which the relay's end-to-end encryption needs for
// its keys and nonces. Expo's native one is the secure source.
const g = globalThis as { crypto?: { getRandomValues?: unknown } }
if (typeof g.crypto?.getRandomValues !== 'function') {
  g.crypto = Object.assign(g.crypto ?? {}, { getRandomValues })
}
