import { Request, Response, NextFunction } from 'express'
import { Sandbox, SandboxError, NotFoundError, ErrorCode } from 'rebyte-sandbox'

const TRANSIENT_CONNECT_ERRORS = new Set<string>([
  ErrorCode.CONCURRENT_OPERATION,
  ErrorCode.SANDBOX_PAUSING,
  ErrorCode.INVALID_STATE_TRANSITION,
])

type ConnectConfig = Parameters<typeof Sandbox.connect>[1]

export interface EnsureVmRunningOptions {
  getSandboxId: (req: Request) => string | undefined
  getConfig: (req: Request) => Promise<ConnectConfig> | ConnectConfig
  /** Optional post-connect readiness hook (e.g. wait for envd). */
  waitForReady?: (sandbox: Sandbox) => Promise<void>
  timeoutMs?: number
  maxRetries?: number
  retryIntervalMs?: number
}

declare global {
  namespace Express {
    interface Request {
      sandbox?: Sandbox
    }
  }
}

function respondError(res: Response, status: number, message: string, retryable: boolean, code?: string) {
  res.status(status).json({ message, retryable, code })
}

export function ensureVmRunning(opts: EnsureVmRunningOptions) {
  const timeoutMs = opts.timeoutMs ?? 5 * 60_000
  const maxRetries = opts.maxRetries ?? 15
  const retryIntervalMs = opts.retryIntervalMs ?? 4000

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const sandboxId = opts.getSandboxId(req)
    if (!sandboxId) {
      respondError(res, 400, 'missing sandboxId', false, 'missing_sandbox_id')
      return
    }

    let config: ConnectConfig
    try {
      config = await opts.getConfig(req)
    } catch (err) {
      respondError(res, 500, (err as Error).message ?? 'config error', false, 'config_error')
      return
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const sandbox = await Sandbox.connect(sandboxId, config)
        await sandbox.setTimeout(timeoutMs)
        if (opts.waitForReady) await opts.waitForReady(sandbox)
        req.sandbox = sandbox
        next()
        return
      } catch (err) {
        const code = err instanceof SandboxError ? err.errorCode : undefined
        const transient = code !== undefined && TRANSIENT_CONNECT_ERRORS.has(code)

        if (!transient || attempt === maxRetries) {
          const message = (err as Error).message ?? 'vm not ready'
          if (err instanceof NotFoundError) {
            respondError(res, 404, message, false, code)
          } else if (transient && attempt === maxRetries) {
            respondError(res, 504, message, true, code)
          } else {
            respondError(res, 503, message, true, code)
          }
          return
        }

        await new Promise((r) => setTimeout(r, retryIntervalMs))
      }
    }
  }
}
