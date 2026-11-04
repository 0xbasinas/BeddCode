import type { StreamState } from './hostClient.ts'

// What the thread header shows about the event stream. 'caught-up' only follows a real
// reconnect, never the first connect.
export type StreamNote = {
  seenLive: boolean
  note: 'none' | 'reconnecting' | 'caught-up'
}

export const CAUGHT_UP_SHOW_MS = 1500
export const CAUGHT_UP_FADE_MS = 400

export const initialStreamNote: StreamNote = { seenLive: false, note: 'none' }

export function nextStreamNote(prev: StreamNote, state: StreamState): StreamNote {
  if (state !== 'live') {
    return prev.seenLive ? { seenLive: true, note: 'reconnecting' } : prev
  }
  return { seenLive: true, note: prev.note === 'reconnecting' ? 'caught-up' : prev.note }
}

// Hides the note once its time is up.
export function clearStreamNote(prev: StreamNote): StreamNote {
  return prev.note === 'caught-up' ? { ...prev, note: 'none' } : prev
}
