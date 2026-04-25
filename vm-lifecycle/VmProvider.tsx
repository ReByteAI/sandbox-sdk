/**
 * VmProvider — exposes a sandboxId to descendants. Nothing more.
 *
 * The gateway transparently auto-resumes paused VMs on the proxy path
 * (microsandbox commit 820a6119), so the client treats a sandbox like any
 * other HTTP endpoint: fire requests, get responses. No readiness gate, no
 * keep-alive, no polling.
 */

import { createContext, useContext, useMemo, type ReactNode } from 'react'

interface VmContextValue {
  sandboxId: string
}

const VmContext = createContext<VmContextValue | null>(null)

export function useVm(): VmContextValue {
  const v = useContext(VmContext)
  if (!v) throw new Error('useVm must be used within <VmProvider>')
  return v
}

export interface VmProviderProps {
  sandboxId: string | null
  children: ReactNode
}

export function VmProvider({ sandboxId, children }: VmProviderProps) {
  const value = useMemo<VmContextValue>(
    () => ({ sandboxId: sandboxId ?? '' }),
    [sandboxId],
  )
  return <VmContext.Provider value={value}>{children}</VmContext.Provider>
}
