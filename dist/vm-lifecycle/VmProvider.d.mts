import * as react_jsx_runtime from 'react/jsx-runtime';
import { ReactNode } from 'react';

declare const VM_POLL: {
    readonly READY_MS: 30000;
    readonly NOT_READY_MS: 2000;
};
interface VmError {
    message: string;
    retryable: boolean;
    code?: string;
}
declare function parseVmError(error: unknown): VmError;
interface VmApi<H = unknown> {
    /** Ensure the VM is up. Called on a polling loop while the provider is mounted. */
    ensure: (sandboxId: string) => Promise<unknown>;
    /** Optional inside-VM readiness probe (e.g. gRPC health). When provided,
     *  isReady gates on this succeeding in addition to ensure. */
    health?: (sandboxId: string) => Promise<H>;
}
interface VmContextValue<H> {
    sandboxId: string;
    isReady: boolean;
    health: H | null;
    vmError: VmError | null;
    /** Clear any non-retryable error and re-fire the ensure query now. */
    ensureRunning: () => void;
}
declare function useVm<H = unknown>(): VmContextValue<H>;
interface VmProviderProps<H> {
    sandboxId: string | null;
    api: VmApi<H>;
    children: ReactNode;
}
declare function VmProvider<H = unknown>({ sandboxId, api, children, }: VmProviderProps<H>): react_jsx_runtime.JSX.Element;

export { VM_POLL, type VmApi, type VmError, VmProvider, type VmProviderProps, parseVmError, useVm };
