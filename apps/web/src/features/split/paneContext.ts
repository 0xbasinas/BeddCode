import { createContext, useContext } from 'react'

/** What a session pane knows about the split it is in. */
export interface PaneInfo {
  index: number
  count: number
  /** The pane the keyboard acts on: the last one clicked or typed in. */
  active: boolean
  /** Takes this pane away; the others widen. */
  close(): void
  /** Shows this session alone. */
  solo(): void
}

export const PaneContext = createContext<PaneInfo | undefined>(undefined)

/** This pane's place in the split, or nothing when its session is shown alone. */
export function usePane(): PaneInfo | undefined {
  return useContext(PaneContext)
}
