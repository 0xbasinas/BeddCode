import { createContext, useContext, type ReactNode } from 'react'
import { LOCAL_HOST_KEY } from './hostCatalog.ts'

const HostScope = createContext<string>(LOCAL_HOST_KEY)

/** Says which host everything below talks to, so panes need not pass a host through every level. */
export function HostScopeProvider({ hostKey, children }: { hostKey: string; children: ReactNode }) {
  return <HostScope.Provider value={hostKey}>{children}</HostScope.Provider>
}

export const useHostKey = () => useContext(HostScope)
