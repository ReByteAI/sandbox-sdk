import { Request, Response, NextFunction } from 'express';
import { Sandbox } from 'rebyte-sandbox';

type ConnectConfig = Parameters<typeof Sandbox.connect>[1];
interface EnsureVmRunningOptions {
    getSandboxId: (req: Request) => string | undefined;
    getConfig: (req: Request) => Promise<ConnectConfig> | ConnectConfig;
    /** Optional post-connect readiness hook (e.g. wait for envd). */
    waitForReady?: (sandbox: Sandbox) => Promise<void>;
    timeoutMs?: number;
    maxRetries?: number;
    retryIntervalMs?: number;
}
declare global {
    namespace Express {
        interface Request {
            sandbox?: Sandbox;
        }
    }
}
declare function ensureVmRunning(opts: EnsureVmRunningOptions): (req: Request, res: Response, next: NextFunction) => Promise<void>;

export { type EnsureVmRunningOptions, ensureVmRunning };
