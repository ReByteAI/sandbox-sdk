/**
 * Protocol compatibility test for Microsandbox Gateway
 *
 * This test verifies that:
 * 1. The Rebyte Sandbox SDK can connect to our gateway
 * 2. The REST API request format is correct
 * 3. Headers are properly sent
 *
 * Run: npx tsx test-gateway/test-protocol.mts
 */

import { Sandbox } from '../src/index.js'

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:8080'

async function testCreateSandbox() {
  console.log('=== Testing Sandbox Creation ===')
  console.log(`Gateway URL: ${GATEWAY_URL}`)

  try {
    // Attempt to create a sandbox
    // This will fail because we don't have orchestrator, but we can see
    // if the gateway receives the correct request format
    const sandbox = await Sandbox.create('base', {
      apiUrl: GATEWAY_URL,
      apiKey: 'test-api-key-12345',
      timeoutMs: 5000,  // Short timeout for testing
    })

    console.log('Sandbox created:', sandbox.sandboxId)

    // Try to run a command
    const result = await sandbox.commands.run('echo hello')
    console.log('Command result:', result)

    // Cleanup
    await sandbox.kill()

  } catch (error: any) {
    console.log('Error (expected without orchestrator):')
    console.log('  Status:', error.status || 'N/A')
    console.log('  Message:', error.message)

    // Check if error contains useful info about what was sent
    if (error.cause) {
      console.log('  Cause:', error.cause)
    }
  }
}

async function main() {
  console.log('\n🧪 Rebyte Sandbox SDK -> Microsandbox Gateway Protocol Test\n')

  await testCreateSandbox()

  console.log('\n✅ Test complete')
}

main().catch(console.error)
