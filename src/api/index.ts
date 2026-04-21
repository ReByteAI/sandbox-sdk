import createClient, { FetchResponse } from 'openapi-fetch'

import type { components, paths } from './schema.gen'
import { defaultHeaders } from './metadata'
import { ConnectionConfig } from '../connectionConfig'
import { AuthenticationError, RateLimitError, SandboxError } from '../errors'
import { createApiLogger } from '../logs'

export function handleApiError(
  response: FetchResponse<any, any, any>,
  errorClass: new (
    message: string,
    stackTrace?: string,
    errorCode?: string
  ) => Error = SandboxError,
  stackTrace?: string
): Error | undefined {
  // Use response.ok (status 2xx) as the signal — `response.error` may be
  // undefined even on a non-2xx response when the server returns an empty
  // body (e.g. 401 with content-length: 0). Without this, callers fall
  // through to `res.data!.sandboxID` and crash with a confusing TypeError.
  if (response.response.ok) {
    return
  }

  if (response.response.status === 401) {
    const message = 'Unauthorized, please check your credentials.'
    const content = response.error?.message ?? response.error

    if (content) {
      return new AuthenticationError(`${message} - ${content}`)
    }
    return new AuthenticationError(message)
  }

  if (response.response.status === 429) {
    const message = 'Rate limit exceeded, please try again later'
    const content = response.error?.message ?? response.error

    if (content) {
      return new RateLimitError(`${message} - ${content}`)
    }
    return new RateLimitError(message)
  }

  const message =
    response.error?.message ??
    response.error ??
    response.response.statusText ??
    'Unknown error'
  const errorCode = response.error?.error_code as string | undefined
  return new errorClass(`${response.response.status}: ${message}`, stackTrace, errorCode)
}

/**
 * Client for interacting with the rebyte-sandbox API.
 */
class ApiClient {
  readonly api: ReturnType<typeof createClient<paths>>

  constructor(
    config: ConnectionConfig,
    opts: {
      requireAccessToken?: boolean
      requireApiKey?: boolean
    } = { requireAccessToken: false, requireApiKey: false }
  ) {
    if (opts?.requireApiKey && !config.apiKey) {
      throw new AuthenticationError(
        "API key is required. Pass it via Sandbox.create({ apiKey: '...' })."
      )
    }

    if (opts?.requireAccessToken && !config.accessToken) {
      throw new AuthenticationError(
        'Access token is required. Pass `accessToken` in options.'
      )
    }

    this.api = createClient<paths>({
      baseUrl: config.apiUrl,
      // keepalive: true, // TODO: Return keepalive
      headers: {
        ...defaultHeaders,
        ...(config.apiKey && { 'X-API-KEY': config.apiKey }),
        ...(config.accessToken && {
          Authorization: `Bearer ${config.accessToken}`,
        }),
        ...config.headers,
      },
      querySerializer: {
        array: {
          style: 'form',
          explode: false,
        },
      },
    })

    if (config.logger) {
      this.api.use(createApiLogger(config.logger))
    }
  }
}

export type { components, paths }
export { ApiClient }
