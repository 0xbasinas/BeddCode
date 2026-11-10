import AsyncStorage from '@react-native-async-storage/async-storage'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { HandoffPolicy } from '@beddcode/client-runtime'

import { defaultHandoffPolicy, type HandoffHostPolicies } from './autoHandoffPolicy'

export { defaultHandoffPolicy, policyFor } from './autoHandoffPolicy'

export const useAutoHandoff = create<{
  hosts: HandoffHostPolicies
  setPolicy(host: string, project: string, policy: HandoffPolicy): void
}>()(
  persist(
    (set) => ({
      hosts: {},
      setPolicy: (host, project, policy) =>
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
        }),
    }),
    { name: 'beddcode.auto-handoff.v1', storage: createJSONStorage(() => AsyncStorage) },
  ),
)
