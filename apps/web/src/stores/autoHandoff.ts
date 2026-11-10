import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { HandoffPolicy } from '@beddcode/client-runtime'
import type { SharedSettingsPatch } from '@beddcode/contracts'

type HandoffPush = (host: string, patch: SharedSettingsPatch) => void
let handoffPush: HandoffPush | undefined
export function setHandoffPush(fn: HandoffPush | undefined) {
  handoffPush = fn
}

export const defaultHandoffPolicy: HandoffPolicy = {
  mode: 'off',
  fallback: [],
  maxHops: 3,
  cooldownMs: 30 * 60_000,
}
export const useAutoHandoff = create<{
  hosts: Record<string, { global: HandoffPolicy; projects: Record<string, HandoffPolicy> }>
  setPolicy(host: string, project: string, policy: HandoffPolicy): void
}>()(
  persist(
    (set) => ({
      hosts: {},
      setPolicy: (host, project, policy) => {
        set((state) => {
          const current = state.hosts[host] ?? { global: defaultHandoffPolicy, projects: {} }
          return {
            hosts: {
              ...state.hosts,
              [host]: project
                ? { ...current, projects: { ...current.projects, [project]: policy } }
                : { ...current, global: policy },
            },
          }
        })
        handoffPush?.(
          host,
          project ? { handoff: { projects: { [project]: policy } } } : { handoff: { global: policy } },
        )
      },
    }),
    { name: 'beddcode.auto-handoff.v1', storage: createJSONStorage(() => localStorage) },
  ),
)
