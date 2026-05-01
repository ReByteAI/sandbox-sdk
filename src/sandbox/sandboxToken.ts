/**
 * Mint a sandbox-scoped JWT for the gateway proxy path.
 *
 * The gateway authenticates proxy requests by HS256-verifying the token
 * against `sha256(api_key)` for the team named in the JWT's `team_id`
 * claim. The `sandbox_id` claim restricts the token to a single sandbox —
 * a leaked token can only reach that one VM and only until `exp`.
 *
 * Use this to hand a least-privilege credential to an untrusted client
 * (a browser, a third-party callback, a per-tenant subprocess) instead of
 * shipping the raw API key. The Sandbox SDK itself sends the raw API key
 * over `X-API-Key` and does not need this helper for its own traffic.
 *
 * @example
 * ```ts
 * const token = await mintSandboxToken({
 *   apiKey: process.env.MSB_API_KEY!,
 *   teamId: 'agentbox-production',
 *   sandboxId: sandbox.sandboxId,
 *   expSeconds: 600,
 * })
 * // ship token to the browser; browser fetches sandbox URL with
 * // `Authorization: Bearer <token>`
 * ```
 */
export interface MintSandboxTokenOpts {
  /** Root API key for the team (`msb_...`). Used as HMAC secret material. */
  apiKey: string
  /** Team / org ID that owns the sandbox. Goes into the JWT `team_id` claim. */
  teamId: string
  /** Sandbox the token is allowed to reach. Goes into the JWT `sandbox_id` claim. */
  sandboxId: string
  /** Lifetime of the token in seconds. Defaults to 1 hour. */
  expSeconds?: number
}

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s)
}

function base64url(buf: Uint8Array): string {
  let str = ''
  for (let i = 0; i < buf.length; i++) str += String.fromCharCode(buf[i])
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function bytesToHex(buf: Uint8Array): string {
  let out = ''
  for (let i = 0; i < buf.length; i++) {
    out += buf[i].toString(16).padStart(2, '0')
  }
  return out
}

export async function mintSandboxToken(
  opts: MintSandboxTokenOpts
): Promise<string> {
  if (!opts.apiKey) throw new Error('mintSandboxToken: apiKey is required')
  if (!opts.teamId) throw new Error('mintSandboxToken: teamId is required')
  if (!opts.sandboxId)
    throw new Error('mintSandboxToken: sandboxId is required')

  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'HS256', typ: 'JWT' }
  const payload = {
    team_id: opts.teamId,
    sandbox_id: opts.sandboxId,
    exp: now + (opts.expSeconds ?? 3600),
    iat: now,
  }

  const signingInput = `${base64url(utf8(JSON.stringify(header)))}.${base64url(
    utf8(JSON.stringify(payload))
  )}`

  const subtle = (globalThis as any).crypto?.subtle
  if (subtle) {
    const apiKeyHashBuf = await subtle.digest('SHA-256', utf8(opts.apiKey))
    const secret = utf8(bytesToHex(new Uint8Array(apiKeyHashBuf)))
    const key = await subtle.importKey(
      'raw',
      secret,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    const sigBuf = await subtle.sign('HMAC', key, utf8(signingInput))
    return `${signingInput}.${base64url(new Uint8Array(sigBuf))}`
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { createHash, createHmac } = require('node:crypto')
  const apiKeyHash: string = createHash('sha256')
    .update(opts.apiKey)
    .digest('hex')
  const sig: Buffer = createHmac('sha256', apiKeyHash)
    .update(signingInput)
    .digest()
  return `${signingInput}.${base64url(new Uint8Array(sig))}`
}
