import * as Haptics from 'expo-haptics'

// A phone without a vibration motor, or one with haptics switched off, just does nothing.
const quietly = (run: () => Promise<void>) => void run().catch(() => {})

/** A light tick for a tap on a button. */
export const tap = () => quietly(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light))

/** A firmer tap for something that goes out, like a sent message. */
export const send = () => quietly(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium))

/** A click as a value or position snaps, such as a sheet crossing the point where it will close. */
export const snap = () => quietly(() => Haptics.selectionAsync())
