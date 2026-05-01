#!/usr/bin/env node
// End-to-end smoke for the gateway proxy-auth change. Walks the SDK
// through control-plane and data-plane calls, then verifies that
// mintSandboxToken produces a token the gateway accepts on the proxy
// path while a sibling sandbox's token is rejected.
//
// Required env: REBYTE_SANDBOX_API_KEY, TEAM_ID
// Optional: API_URL (default https://dev.rebyte.app), TEST_TEMPLATE_ID

import { Sandbox, mintSandboxToken } from '../dist/index.mjs'

const API_URL = process.env.API_URL || 'https://dev.rebyte.app'
const API_KEY = process.env.REBYTE_SANDBOX_API_KEY
const TEAM_ID = process.env.TEAM_ID
const TEMPLATE_ID = process.env.TEST_TEMPLATE_ID

if (!API_KEY) {
  console.error('REBYTE_SANDBOX_API_KEY is required')
  process.exit(1)
}
if (!TEAM_ID) {
  console.error('TEAM_ID is required')
  process.exit(1)
}

const domain = new URL(API_URL).host

const opts = {
  apiKey: API_KEY,
  apiUrl: API_URL,
  domain,
}

let sandbox
let passed = 0
function ok(name, detail = '') {
  passed++
  console.log(`  ok  ${name}${detail ? `: ${detail}` : ''}`)
}
function fail(name, detail) {
  console.error(`  fail ${name}: ${detail}`)
  process.exit(1)
}

async function main() {
  console.log(`\n[step] create sandbox via SDK (control plane = X-API-KEY)`)
  sandbox = TEMPLATE_ID
    ? await Sandbox.create(TEMPLATE_ID, opts)
    : await Sandbox.create(opts)
  ok('sandbox created', sandbox.sandboxId)

  console.log(`\n[step] commands.run (data plane = envd RPC via gateway)`)
  const run = await sandbox.commands.run('echo hello-from-sdk')
  if (run.exitCode !== 0) fail('commands.run', `exitCode=${run.exitCode}`)
  if (!run.stdout.includes('hello-from-sdk'))
    fail('commands.run stdout', JSON.stringify(run.stdout))
  ok('commands.run echoed via proxy', run.stdout.trim())

  console.log(`\n[step] files.list (data plane = envd REST via gateway)`)
  const ls = await sandbox.files.list('/tmp')
  if (!Array.isArray(ls)) fail('files.list', 'expected array')
  ok('files.list returned entries', `count=${ls.length}`)

  console.log(`\n[step] mint sandbox JWT and call /health on the proxy directly`)
  const goodToken = await mintSandboxToken({
    apiKey: API_KEY,
    teamId: TEAM_ID,
    sandboxId: sandbox.sandboxId,
    expSeconds: 300,
  })
  const badToken = await mintSandboxToken({
    apiKey: API_KEY,
    teamId: TEAM_ID,
    sandboxId: `${sandbox.sandboxId}-wrong`,
    expSeconds: 300,
  })

  const proxyHost = sandbox.getHost(49983)
  // Path that doesn't match any gateway-bypassed route, so the request
  // actually goes through proxy_to_vm and exercises auth.
  const probeUrl = `https://${proxyHost}/__proxy_auth_probe__`

  // Correct JWT: gateway accepts it, proxies to envd, envd returns
  // 404/whatever for the unknown probe path. Anything other than 401 means
  // gateway auth passed.
  const goodRes = await fetch(probeUrl, {
    headers: { Authorization: `Bearer ${goodToken}` },
  })
  if (goodRes.status === 401)
    fail('correct sandbox JWT on proxy', `status=${goodRes.status}`)
  ok('correct sandbox JWT accepted by proxy', `status=${goodRes.status}`)

  // Wrong JWT: gateway should reject with 401 since the JWT's sandbox_id
  // doesn't match the host's sandbox_id.
  const badRes = await fetch(probeUrl, {
    headers: { Authorization: `Bearer ${badToken}` },
  })
  if (badRes.status !== 401)
    fail('wrong sandbox JWT on proxy', `expected 401 got ${badRes.status}`)
  ok('wrong sandbox JWT rejected by proxy', `status=${badRes.status}`)

  // No auth: gateway should reject with 401 (the host-bypass that used to
  // let proxy traffic through with no credential is now removed).
  const noAuthRes = await fetch(probeUrl)
  if (noAuthRes.status !== 401)
    fail('no auth on proxy', `expected 401 got ${noAuthRes.status}`)
  ok('no-auth proxy request rejected', `status=${noAuthRes.status}`)

  console.log(`\n${passed} checks passed`)
}

main()
  .catch((err) => {
    console.error(`fatal: ${err?.message ?? err}`)
    process.exitCode = 1
  })
  .finally(async () => {
    if (sandbox) {
      try {
        await sandbox.kill()
      } catch (e) {
        console.error(`cleanup kill failed: ${e?.message ?? e}`)
      }
    }
  })
