import { Logger } from './logs'
import { version } from './api/metadata'

export const REQUEST_TIMEOUT_MS = 120_000 // 120 seconds (pause/resume needs ~60s for snapshot + GCS upload)
export const DEFAULT_SANDBOX_TIMEOUT_MS = 300_000 // 300 seconds
export const KEEPALIVE_PING_INTERVAL_SEC = 50 // 50 seconds

export const KEEPALIVE_PING_HEADER = 'Keepalive-Ping-Interval'

export const SANDBOX_DOMAIN_ENV_VAR = 'SANDBOX_DOMAIN'
export const SANDBOX_API_URL_ENV_VAR = 'SANDBOX_API_URL'

const LEGACY_SANDBOX_DOMAIN_ENV_VAR = 'REBYTE_SANDBOX_DOMAIN'
const LEGACY_SANDBOX_API_URL_ENV_VAR = 'REBYTE_SANDBOX_API_URL'

function nonEmpty(value: string | undefined) {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

function getEnvValue(...names: string[]) {
  if (typeof process === 'undefined' || !process.env) {
    return undefined
  }

  for (const name of names) {
    const value = nonEmpty(process.env[name])
    if (value) {
      return value
    }
  }

  return undefined
}

function getDomainFromApiUrl(apiUrl: string | undefined) {
  if (!apiUrl) {
    return undefined
  }

  try {
    return new URL(apiUrl).host
  } catch {
    return undefined
  }
}

function missingSandboxDomain(): never {
  throw new Error(
    `Sandbox API domain is required. Pass \`domain\` or \`apiUrl\`, or set ${SANDBOX_DOMAIN_ENV_VAR} or ${SANDBOX_API_URL_ENV_VAR}.`
  )
}

/**
 * Connection options for requests to the API.
 */
export interface ConnectionOpts {
  /**
   * rebyte-sandbox API key to use for authentication.
   */
  apiKey?: string
  /**
   * Access token to use for authentication.
   */
  accessToken?: string
  /**
   * Domain to use for the API.
   *
   * @default SANDBOX_DOMAIN or the host from SANDBOX_API_URL
   */
  domain?: string
  /**
   * API Url to use for the API.
   * @internal
   * @default `https://${domain}`
   */
  apiUrl?: string
  /**
   * Sandbox Url to use for the API.
   * @internal
   * @default `https://${port}-${sandboxID}.${domain}`
   */
  sandboxUrl?: string
  /**
   * If true the SDK starts in the debug mode and connects to the local envd API server.
   * @internal
   * @default false
   */
  debug?: boolean
  /**
   * Timeout for requests to the API in **milliseconds**.
   *
   * @default 120_000 // 120 seconds
   */
  requestTimeoutMs?: number
  /**
   * Logger to use for logging messages. It can accept any object that implements `Logger` interface—for example, {@link console}.
   */
  logger?: Logger

  /**
   * Additional headers to send with the request.
   */
  headers?: Record<string, string>
}

/**
 * Configuration for connecting to the API.
 */
export class ConnectionConfig {
  public static envdPort = 49983

  readonly debug: boolean
  readonly domain: string
  readonly apiUrl: string
  readonly sandboxUrl?: string
  readonly logger?: Logger

  readonly requestTimeoutMs: number

  readonly apiKey?: string
  readonly accessToken?: string

  readonly headers?: Record<string, string>

  constructor(opts?: ConnectionOpts) {
    this.apiKey = opts?.apiKey
    this.debug = opts?.debug ?? false

    const apiUrl =
      nonEmpty(opts?.apiUrl) ||
      getEnvValue(SANDBOX_API_URL_ENV_VAR, LEGACY_SANDBOX_API_URL_ENV_VAR)
    const domain =
      nonEmpty(opts?.domain) ||
      getEnvValue(SANDBOX_DOMAIN_ENV_VAR, LEGACY_SANDBOX_DOMAIN_ENV_VAR) ||
      getDomainFromApiUrl(apiUrl)

    this.domain = domain ?? (this.debug ? 'localhost' : missingSandboxDomain())
    this.accessToken = opts?.accessToken
    this.requestTimeoutMs = opts?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS
    this.logger = opts?.logger
    this.headers = opts?.headers || {}
    this.headers['User-Agent'] = `rebyte-sandbox-js-sdk/${version}`

    this.apiUrl =
      apiUrl ||
      (this.debug ? 'http://localhost:3000' : `https://${this.domain}`)

    this.sandboxUrl = opts?.sandboxUrl
  }

  getSignal(requestTimeoutMs?: number) {
    const timeout = requestTimeoutMs ?? this.requestTimeoutMs

    return timeout ? AbortSignal.timeout(timeout) : undefined
  }

  getSandboxUrl(
    sandboxId: string,
    opts: { sandboxDomain: string; envdPort: number }
  ) {
    if (this.sandboxUrl) {
      return this.sandboxUrl
    }

    return `${this.debug ? 'http' : 'https'}://${this.getHost(sandboxId, opts.envdPort, opts.sandboxDomain)}`
  }

  getHost(sandboxId: string, port: number, sandboxDomain: string) {
    if (this.debug) {
      return `localhost:${port}`
    }

    return `${port}-${sandboxId}.${sandboxDomain ?? this.domain}`
  }
}

/**
 * User used for the operation in the sandbox.
 */

export const defaultUsername: Username = 'user'
export type Username = string
