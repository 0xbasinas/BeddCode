import * as SecureStore from 'expo-secure-store'

const KEY = 'beddcode.hosts'

/** The paired hosts as saved JSON. They carry pairing tokens, so they live in the keychain/keystore. */
export async function readHosts(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(KEY)
  } catch {
    return null
  }
}

export async function writeHosts(raw: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(KEY, raw)
  } catch {
    // The host just will not be remembered after a restart.
  }
}
