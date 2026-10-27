import { useSyncExternalStore } from 'react'
import { StyleSheet, Text, View } from 'react-native'

// Temporary: shows how long each stage of opening a session takes, to find the slow one.
// Remove this file and its few `openMark` calls once the opening feels right.
const marks: Record<string, number> = {}
const listeners = new Set<() => void>()
let summary = ''

const ORDER: [string, string][] = [
  ['shell', 'screen'],
  ['slide', 'slid'],
  ['thread', 'thread'],
  ['rows', 'rows'],
]

function rebuild() {
  const tap = marks.tap
  summary =
    tap === undefined
      ? ''
      : ORDER.filter(([key]) => marks[key] !== undefined)
          .map(([key, label]) => `${label} ${Math.round(marks[key]! - tap)}`)
          .join(' · ')
  listeners.forEach((l) => l())
}

/** A tap on a session starts a new measurement. */
export function openStart() {
  for (const key of Object.keys(marks)) delete marks[key]
  marks.tap = performance.now()
  rebuild()
}

/** A stage was reached; its time is measured from the tap. Only the first time counts. */
export function openMark(stage: 'shell' | 'slide' | 'thread' | 'rows') {
  if (marks.tap === undefined || marks[stage] !== undefined) return
  marks[stage] = performance.now()
  rebuild()
}

const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => void listeners.delete(listener)
}

/** The milliseconds since the tap at each stage, as a small label over the session screen. */
export function OpenTiming() {
  const text = useSyncExternalStore(subscribe, () => summary)
  if (!text) return null
  return (
    <View pointerEvents="none" style={styles.box}>
      <Text style={styles.text}>{`ms since tap: ${text}`}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  box: {
    position: 'absolute',
    right: 6,
    bottom: 170,
    backgroundColor: 'rgba(0,0,0,0.75)',
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  text: { color: '#8fb2f5', fontSize: 10, fontFamily: 'monospace' },
})
