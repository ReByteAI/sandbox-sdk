/**
 * Structured error codes returned by the API.
 *
 * Use these to programmatically determine what went wrong:
 * ```ts
 * try {
 *   await sandbox.resume()
 * } catch (e) {
 *   if (e instanceof SandboxError) {
 *     switch (e.errorCode) {
 *       case ErrorCode.NO_ORCHESTRATOR:
 *         // Retry after delay
 *         break
 *       case ErrorCode.SANDBOX_NOT_FOUND:
 *         // Recreate the sandbox
 *         break
 *     }
 *   }
 * }
 * ```
 */
export const ErrorCode = {
  // Infrastructure (retryable after delay)
  NO_ORCHESTRATOR: 'no_orchestrator',
  ORCHESTRATOR_UNREACHABLE: 'orchestrator_unreachable',

  // State conflicts
  SANDBOX_NOT_FOUND: 'sandbox_not_found',
  SANDBOX_ALREADY_RUNNING: 'sandbox_already_running',
  SANDBOX_PAUSING: 'sandbox_pausing',
  SANDBOX_KILLING: 'sandbox_killing',
  CONCURRENT_OPERATION: 'concurrent_operation',
  INVALID_STATE_TRANSITION: 'invalid_state_transition',
  TRANSITION_FAILED: 'transition_failed',

  // Operation failures
  CREATE_FAILED: 'create_failed',
  RESUME_FAILED: 'resume_failed',
  PAUSE_FAILED: 'pause_failed',
  SNAPSHOT_NOT_FOUND: 'snapshot_not_found',

  // Other
  INTERNAL_ERROR: 'internal_error',
  DATABASE_ERROR: 'database_error',
} as const

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode]

// This is the message for the sandbox timeout error when the response code is 502/Unavailable
export function formatSandboxTimeoutError(message: string) {
  return new TimeoutError(
    `${message}: This error is likely due to sandbox timeout. You can modify the sandbox timeout by passing 'timeoutMs' when starting the sandbox or calling '.setTimeout' on the sandbox with the desired timeout.`
  )
}

/**
 * Base class for all sandbox errors.
 *
 * Thrown when general sandbox errors occur.
 */
export class SandboxError extends Error {
  /**
   * Stable error code from the API for programmatic use (e.g. "no_orchestrator", "sandbox_not_found").
   * May be undefined for client-side errors or legacy responses.
   */
  errorCode?: string

  constructor(message?: string, stackTrace?: string, errorCode?: string) {
    super(message)
    this.name = 'SandboxError'
    this.errorCode = errorCode
    if (stackTrace) {
      this.stack = stackTrace
    }
  }
}

/**
 * Thrown when a timeout error occurs.
 *
 * The [unavailable] error type is caused by sandbox timeout.
 *
 * The [canceled] error type is caused by exceeding request timeout.
 *
 * The [deadline_exceeded] error type is caused by exceeding the timeout for command execution, watch, etc.
 *
 * The [unknown] error type is sometimes caused by the sandbox timeout when the request is not processed correctly.
 */
export class TimeoutError extends SandboxError {
  constructor(message: string, stackTrace?: string) {
    super(message, stackTrace)
    this.name = 'TimeoutError'
  }
}

/**
 * Thrown when an invalid argument is provided.
 */
export class InvalidArgumentError extends SandboxError {
  constructor(message: string, stackTrace?: string) {
    super(message, stackTrace)
    this.name = 'InvalidArgumentError'
  }
}

/**
 * Thrown when there is not enough disk space.
 */
export class NotEnoughSpaceError extends SandboxError {
  constructor(message: string, stackTrace?: string) {
    super(message, stackTrace)
    this.name = 'NotEnoughSpaceError'
  }
}

/**
 * Thrown when a resource is not found.
 */
export class NotFoundError extends SandboxError {
  constructor(message: string, stackTrace?: string) {
    super(message, stackTrace)
    this.name = 'NotFoundError'
  }
}

/**
 * Thrown when authentication fails.
 */
export class AuthenticationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthenticationError'
  }
}

/**
 * Thrown when the template uses old envd version. It isn't compatible with the new SDK.
 */
export class TemplateError extends SandboxError {
  constructor(message: string, stackTrace?: string) {
    super(message, stackTrace)
    this.name = 'TemplateError'
  }
}

/**
 * Thrown when the API rate limit is exceeded.
 */
export class RateLimitError extends SandboxError {
  constructor(message: string) {
    super(message)
    this.name = 'RateLimitError'
  }
}

/**
 * Thrown when the build fails.
 */
export class BuildError extends Error {
  constructor(message: string, stackTrace?: string) {
    super(message)
    this.name = 'BuildError'
    if (stackTrace) {
      this.stack = stackTrace
    }
  }
}

/**
 * Thrown when the file upload fails.
 */
export class FileUploadError extends BuildError {
  constructor(message: string, stackTrace?: string) {
    super(message, stackTrace)
    this.name = 'FileUploadError'
  }
}
