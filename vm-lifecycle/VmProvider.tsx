/**
 * VmProvider — keeps a sandbox VM running while mounted.
 *
 * This is the provider's SOLE responsibility. Nothing else.
 *
 *   mount with a sandboxId  →  poll api.ensure(sandboxId) forever
 *   unmount / sandboxId null →  stop polling
 *
 * Polling cadence:
 *   - every 2s while the VM is not yet alive (fast recovery from PAUSING)
 *   - every 30s once alive (keepalive heartbeat)
 *   - refetch on window focus
 *   - stop polling permanently on non-retryable errors (e.g. VM deleted)
 *
 * Observable outputs via useVm():
 *   - isReady:  ensure is succeeding (optionally gated behind api.health)
 *   - vmError:  structured error from the last failed ensure (null while ok)
 *   - health:   the latest health payload if api.health is provided
 *   - ensureRunning():  clear any non-retryable error state and re-poll now
 *
 * NOT in scope:
 *   - Pausing / destroying a VM (call your API directly).
 *   - Deriving business errors (e.g. provisioning failures at a higher level).
 *   - Starting lazily / stopping on demand (wrap conditionally in the tree
 *     instead — mount = warm, unmount = stop).
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

export const VM_POLL = {
  READY_MS: 30_000,
  NOT_READY_MS: 2_000,
} as const

export interface VmError {
  message: string
  retryable: boolean
  code?: string
}

export function parseVmError(error: unknown): VmError {
  const data = (error as { response?: { data?: { message?: string; retryable?: boolean; code?: string } } })?.response?.data

  if (data?.message) {
    return {
      message: data.message,
      retryable: data.retryable !== false,
      code: data.code,
    }
  }
  return {
    message: error instanceof Error ? error.message : 'Failed to start VM',
    retryable: true,
  }
}

export interface VmApi<H = unknown> {
  /** Ensure the VM is up. Called on a polling loop while the provider is mounted. */
  ensure: (sandboxId: string) => Promise<unknown>
  /** Optional inside-VM readiness probe (e.g. gRPC health). When provided,
   *  isReady gates on this succeeding in addition to ensure. */
  health?: (sandboxId: string) => Promise<H>
}

interface VmContextValue<H> {
  sandboxId: string
  isReady: boolean
  health: H | null
  vmError: VmError | null
  /** Clear any non-retryable error and re-fire the ensure query now. */
  ensureRunning: () => void
}

const VmContext = createContext<VmContextValue<unknown> | null>(null)

export function useVm<H = unknown>(): VmContextValue<H> {
  const v = useContext(VmContext)
  if (!v) throw new Error('useVm must be used within <VmProvider>')
  return v as VmContextValue<H>
}

export interface VmProviderProps<H> {
  sandboxId: string | null
  api: VmApi<H>
  children: ReactNode
}

export function VmProvider<H = unknown>({
  sandboxId,
  api,
  children,
}: VmProviderProps<H>) {
  const qc = useQueryClient()

  const ensureKey = useMemo(() => ['vmEnsure', sandboxId ?? ''] as const, [sandboxId])
  const healthKey = useMemo(() => ['vmHealth', sandboxId ?? ''] as const, [sandboxId])

  const ensureQ = useQuery({
    queryKey: ensureKey,
    queryFn: () => api.ensure(sandboxId!),
    enabled: !!sandboxId,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => {
      if (q.state.error && !parseVmError(q.state.error).retryable) return false
      return q.state.data ? VM_POLL.READY_MS : VM_POLL.NOT_READY_MS
    },
    retry: false,
  })

  const ensureOk = !!ensureQ.data
  const hasHealth = !!api.health

  const healthQ = useQuery({
    queryKey: healthKey,
    queryFn: () => api.health!(sandboxId!),
    enabled: !!sandboxId && ensureOk && hasHealth,
    refetchOnWindowFocus: true,
    refetchInterval: (q) => (q.state.data ? VM_POLL.READY_MS : VM_POLL.NOT_READY_MS),
    retry: false,
  })

  const isReady = hasHealth ? !!healthQ.data : ensureOk
  const vmError = useMemo(
    () => (ensureQ.error ? parseVmError(ensureQ.error) : null),
    [ensureQ.error],
  )

  const ensureRunning = useCallback(() => {
    if (!sandboxId) return
    qc.resetQueries({ queryKey: ensureKey })
    qc.invalidateQueries({ queryKey: ensureKey })
    qc.invalidateQueries({ queryKey: healthKey })
  }, [sandboxId, qc, ensureKey, healthKey])

  const value = useMemo<VmContextValue<H>>(
    () => ({
      sandboxId: sandboxId ?? '',
      isReady,
      health: (healthQ.data as H | undefined) ?? null,
      vmError,
      ensureRunning,
    }),
    [sandboxId, isReady, healthQ.data, vmError, ensureRunning],
  )

  return <VmContext.Provider value={value as VmContextValue<unknown>}>{children}</VmContext.Provider>
}
