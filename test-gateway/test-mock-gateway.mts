#!/usr/bin/env npx tsx
/**
 * Rebyte Sandbox SDK Protocol Compatibility Test for Microsandbox Gateway (Mock Mode)
 *
 * This test verifies that the Rebyte Sandbox SDK can communicate with our gateway
 * using the mock mode (no orchestrator required).
 *
 * Prerequisites:
 * 1. Build the gateway: cargo build --package microsandbox-gateway
 * 2. Start mock gateway: ./target/debug/msbgateway --mock
 * 3. Run this test: npx tsx test-gateway/test-mock-gateway.mts
 */

import { Sandbox } from '../dist/index.mjs'

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080'

interface TestResult {
  name: string
  passed: boolean
  error?: string
}

const results: TestResult[] = []

function log(msg: string) {
  console.log(`  ${msg}`)
}

function logSuccess(msg: string) {
  console.log(`  ✓ ${msg}`)
}

function logError(msg: string) {
  console.log(`  ✗ ${msg}`)
}

async function test(name: string, fn: () => Promise<void>) {
  console.log(`\n▶ ${name}`)
  try {
    await fn()
    results.push({ name, passed: true })
    logSuccess('PASSED')
  } catch (error: any) {
    const errorMsg = error?.message || error?.toString?.() || JSON.stringify(error) || 'Unknown error'
    results.push({ name, passed: false, error: errorMsg })
    logError(`FAILED: ${errorMsg}`)
    if (error?.stack) {
      console.log(`  Stack: ${error.stack.split('\n').slice(0, 3).join('\n  ')}`)
    }
  }
}

async function testHealthCheck() {
  const response = await fetch(`${GATEWAY_URL}/health`)
  if (!response.ok) {
    throw new Error(`Health check failed with status ${response.status}`)
  }
  const data = await response.json()
  log(`Health response: ${JSON.stringify(data)}`)
  if (data.mode !== 'mock') {
    throw new Error(`Expected mock mode, got: ${data.mode}`)
  }
}

async function testCreateSandboxRaw() {
  // Test raw HTTP to see exact request/response format
  const response = await fetch(`${GATEWAY_URL}/sandboxes`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'test-api-key',
    },
    body: JSON.stringify({
      templateID: 'base',
      timeout: 300,
      metadata: { test: 'true' },
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Create failed with status ${response.status}: ${text}`)
  }

  const data = await response.json()
  log(`Create response: ${JSON.stringify(data, null, 2)}`)

  // Verify required fields
  if (!data.sandboxID) throw new Error('Missing sandboxID')
  if (!data.templateID) throw new Error('Missing templateID')
  if (!data.envdVersion) throw new Error('Missing envdVersion')
  if (!data.startedAt) throw new Error('Missing startedAt')
  if (!data.endAt) throw new Error('Missing endAt')

  return data.sandboxID
}

async function testGetSandboxRaw(sandboxId: string) {
  const response = await fetch(`${GATEWAY_URL}/sandboxes/${sandboxId}`, {
    headers: {
      'X-API-Key': 'test-api-key',
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Get failed with status ${response.status}: ${text}`)
  }

  const data = await response.json()
  log(`Get response: ${JSON.stringify(data, null, 2)}`)

  if (data.sandboxID !== sandboxId) {
    throw new Error(`Sandbox ID mismatch: expected ${sandboxId}, got ${data.sandboxID}`)
  }
}

async function testSetTimeoutRaw(sandboxId: string) {
  const response = await fetch(`${GATEWAY_URL}/sandboxes/${sandboxId}/timeout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'test-api-key',
    },
    body: JSON.stringify({ timeout: 600 }),
  })

  if (response.status !== 204) {
    const text = await response.text()
    throw new Error(`Set timeout failed with status ${response.status}: ${text}`)
  }

  log('Timeout updated successfully')
}

async function testDeleteSandboxRaw(sandboxId: string) {
  const response = await fetch(`${GATEWAY_URL}/sandboxes/${sandboxId}`, {
    method: 'DELETE',
    headers: {
      'X-API-Key': 'test-api-key',
    },
  })

  if (response.status !== 204) {
    const text = await response.text()
    throw new Error(`Delete failed with status ${response.status}: ${text}`)
  }

  log('Sandbox deleted successfully')
}

async function testGetDeletedSandbox(sandboxId: string) {
  const response = await fetch(`${GATEWAY_URL}/sandboxes/${sandboxId}`, {
    headers: {
      'X-API-Key': 'test-api-key',
    },
  })

  if (response.status !== 404) {
    throw new Error(`Expected 404 for deleted sandbox, got ${response.status}`)
  }

  log('Correctly returned 404 for deleted sandbox')
}

async function testPauseSandboxRaw(sandboxId: string) {
  const response = await fetch(`${GATEWAY_URL}/sandboxes/${sandboxId}/pause`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'test-api-key',
    },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Pause failed with status ${response.status}: ${text}`)
  }

  log('Sandbox paused successfully')

  // Verify state changed
  const getResponse = await fetch(`${GATEWAY_URL}/sandboxes/${sandboxId}`, {
    headers: { 'X-API-Key': 'test-api-key' },
  })
  const data = await getResponse.json()
  if (data.state !== 'paused') {
    throw new Error(`Expected state 'paused', got '${data.state}'`)
  }
  log(`State verified: ${data.state}`)
}

async function testConnectSandboxRaw(sandboxId: string) {
  const response = await fetch(`${GATEWAY_URL}/sandboxes/${sandboxId}/connect`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': 'test-api-key',
    },
    body: JSON.stringify({ timeout: 300 }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Connect failed with status ${response.status}: ${text}`)
  }

  const data = await response.json()
  log(`Connect response: sandboxID=${data.sandboxID}, envdVersion=${data.envdVersion}`)

  // Verify state changed back to running
  const getResponse = await fetch(`${GATEWAY_URL}/sandboxes/${sandboxId}`, {
    headers: { 'X-API-Key': 'test-api-key' },
  })
  const info = await getResponse.json()
  if (info.state !== 'running') {
    throw new Error(`Expected state 'running', got '${info.state}'`)
  }
  log(`State verified: ${info.state}`)
}

async function testRebyteSandboxSdkCreate() {
  // Test with actual Rebyte Sandbox SDK
  log(`Using gateway at: ${GATEWAY_URL}`)

  const sandbox = await Sandbox.create('base', {
    apiUrl: GATEWAY_URL,
    apiKey: 'test-api-key',
    timeoutMs: 300000,
    requestTimeoutMs: 5000,
  })

  log(`Created sandbox: ${sandbox.sandboxId}`)

  // Get sandbox info
  const info = await sandbox.getInfo()
  log(`Sandbox info: templateId=${info.templateId}, state=${info.state}`)

  // Clean up
  await sandbox.kill()
  log('Sandbox killed')
}

async function testRebyteSandboxSdkCommandsRun() {
  // Test SDK commands.run() - this tests Connect RPC streaming protocol
  log(`Testing commands.run() with SDK`)

  // Use sandboxUrl to override the envd URL so it connects to our mock gateway
  // The SDK will add Rebyte-Sandbox-Id header which mock gateway uses to identify the sandbox
  const sandbox = await Sandbox.create('base', {
    apiUrl: GATEWAY_URL,
    apiKey: 'test-api-key',
    timeoutMs: 300000,
    requestTimeoutMs: 10000,
    sandboxUrl: GATEWAY_URL,  // Connect envd calls to our mock gateway
  })

  try {
    log(`Created sandbox: ${sandbox.sandboxId}`)

    // Test 1: Simple echo command
    log('Running test 1: echo command...')
    const echoResult = await sandbox.commands.run('echo "Hello, World!"')
    log(`Echo result: exitCode=${echoResult.exitCode}, stdout="${echoResult.stdout.trim()}"`)
    if (echoResult.exitCode !== 0) {
      throw new Error(`[Test 1] Expected exit code 0, got ${echoResult.exitCode}`)
    }
    if (!echoResult.stdout.includes('Hello, World!')) {
      throw new Error(`[Test 1] Expected stdout to contain "Hello, World!", got "${echoResult.stdout}"`)
    }
    log('Test 1 passed!')

    // Test 2: Command that outputs to stderr (expects CommandExitError)
    log('Running test 2: stderr command...')
    try {
      await sandbox.commands.run('cat /nonexistent')
      throw new Error('[Test 2] Expected command to fail but it succeeded')
    } catch (err: any) {
      // CommandExitError is thrown when command exits with non-zero exit code
      if (err.name !== 'CommandExitError' && !err.constructor?.name?.includes('CommandExitError')) {
        throw new Error(`[Test 2] Expected CommandExitError, got: ${err.name || err.constructor?.name}`)
      }
      log(`Stderr result: exitCode=${err.exitCode}, stderr="${err.stderr?.trim() || ''}"`)
      if (err.exitCode === 0) {
        throw new Error('[Test 2] Expected non-zero exit code for missing file')
      }
      if (!err.stderr || !err.stderr.includes('No such file')) {
        throw new Error(`[Test 2] Expected stderr to contain "No such file", got "${err.stderr || ''}"`)
      }
    }
    log('Test 2 passed!')

    // Test 3: pwd command
    log('Running test 3: pwd command...')
    const pwdResult = await sandbox.commands.run('pwd')
    log(`Pwd result: exitCode=${pwdResult.exitCode}, stdout="${pwdResult.stdout.trim()}"`)
    if (pwdResult.exitCode !== 0) {
      throw new Error(`[Test 3] Expected exit code 0 for pwd, got ${pwdResult.exitCode}`)
    }
    log('Test 3 passed!')

    log('All commands.run() tests passed!')
  } finally {
    await sandbox.kill()
    log('Sandbox killed')
  }
}

async function main() {
  console.log('╔════════════════════════════════════════════════════════════╗')
  console.log('║   Rebyte Sandbox SDK Protocol Compat Test (Mock GW)       ║')
  console.log('╚════════════════════════════════════════════════════════════╝')
  console.log(`\nGateway URL: ${GATEWAY_URL}`)

  // Check if gateway is running
  try {
    await fetch(`${GATEWAY_URL}/health`)
  } catch {
    console.log('\n❌ Gateway is not running!')
    console.log('   Please start the mock gateway first:')
    console.log('   cargo run --package microsandbox-gateway -- --mock')
    process.exit(1)
  }

  // Run tests
  await test('Health Check', testHealthCheck)

  let sandboxId: string | undefined

  await test('Create Sandbox (Raw HTTP)', async () => {
    sandboxId = await testCreateSandboxRaw()
  })

  if (sandboxId) {
    await test('Get Sandbox (Raw HTTP)', () => testGetSandboxRaw(sandboxId!))
    await test('Set Timeout (Raw HTTP)', () => testSetTimeoutRaw(sandboxId!))
    await test('Pause Sandbox (Raw HTTP)', () => testPauseSandboxRaw(sandboxId!))
    await test('Connect/Resume Sandbox (Raw HTTP)', () => testConnectSandboxRaw(sandboxId!))
    await test('Delete Sandbox (Raw HTTP)', () => testDeleteSandboxRaw(sandboxId!))
    await test('Verify Deletion (Raw HTTP)', () => testGetDeletedSandbox(sandboxId!))
  }

  await test('Rebyte Sandbox SDK Create/Kill Sandbox', testRebyteSandboxSdkCreate)
  await test('Rebyte Sandbox SDK commands.run() Streaming', testRebyteSandboxSdkCommandsRun)

  // Summary
  console.log('\n' + '═'.repeat(60))
  console.log('                        SUMMARY')
  console.log('═'.repeat(60))

  const passed = results.filter(r => r.passed).length
  const failed = results.filter(r => !r.passed).length

  for (const r of results) {
    console.log(`  ${r.passed ? '✓' : '✗'} ${r.name}`)
    if (!r.passed && r.error) {
      console.log(`      Error: ${r.error}`)
    }
  }

  console.log('─'.repeat(60))
  console.log(`  Total: ${results.length} | Passed: ${passed} | Failed: ${failed}`)
  console.log('═'.repeat(60))

  if (failed > 0) {
    process.exit(1)
  }
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
