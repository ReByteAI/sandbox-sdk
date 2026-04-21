/**
 * Network Egress Restriction Tests (rebyte-sandbox API)
 *
 * Tests the network egress firewall functionality:
 * - Default (no config): Full internet access
 * - denyOut=["0.0.0.0/0"]: DROP all traffic
 * - allowOut=[ip] + denyOut=["0.0.0.0/0"]: Only whitelisted IPs
 * - allowedDomains=[domain] + denyOut=["0.0.0.0/0"]: Only whitelisted domains
 *
 * Run:
 *   npx vitest run tests/integration/network.test.ts
 *
 * With large template:
 *   TEST_TEMPLATE=large npx vitest run tests/integration/network.test.ts
 *
 * Against production:
 *   TEST_ENV=prod npx vitest run tests/integration/network.test.ts
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  printTestHeader,
  ensureProdApiKey,
} from './common'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_ID = getTemplateId()

/**
 * Test network connectivity from sandbox to a target IP.
 * Uses curl to test TCP connectivity.
 * Returns true if the target is reachable, false otherwise.
 */
async function testConnectivity(
  sandbox: Sandbox,
  targetIp: string,
  timeoutSecs: number = 5
): Promise<boolean> {
  try {
    // Use curl to connect to the target - just try to connect, don't care about response
    // Exit codes:
    //   0 = success (connected)
    //   7 = connection refused
    //   28 = timeout
    //   60 = SSL cert error (means we connected)
    const result = await sandbox.commands.run(
      `curl -s -m ${timeoutSecs} -o /dev/null -w "%{http_code}" https://${targetIp}/ 2>&1; echo "EXIT:$?"`,
      { timeoutMs: (timeoutSecs + 5) * 1000 }
    )

    // Parse exit code from output
    const exitMatch = result.stdout.match(/EXIT:(\d+)/)
    const exitCode = exitMatch ? parseInt(exitMatch[1]) : -1

    // Connection successful if exit code is 0 or 60 (SSL error means we connected)
    const success = exitCode === 0 || exitCode === 60

    console.log(
      `  Curl to ${targetIp}: exit=${exitCode} (${success ? 'REACHABLE' : 'UNREACHABLE'})`
    )

    return success
  } catch (e) {
    console.log(`  Curl to ${targetIp} failed: ${e}`)
    return false
  }
}

describe('Network Egress Restrictions', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('default (no config) allows internet access', async () => {
    printTestHeader('Network Test: default (allow all)')

    // Create sandbox with default network config (no restrictions)
    console.log('1. Creating sandbox with default network config...')
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
      // Default: no network restrictions (allow all)
    })
    const createTime = Date.now() - createStart
    console.log(`   Sandbox created: ${sandbox.sandboxId} (${createTime}ms)`)

    try {
      // Test: VM should be able to reach 8.8.8.8
      console.log('\n2. Testing connectivity to 8.8.8.8...')
      const canReach = await testConnectivity(sandbox, '8.8.8.8', 5)

      expect(canReach).toBe(true)
      console.log('\n=== Test Passed: default allows internet access ===')
    } finally {
      console.log('\n3. Cleaning up...')
      await sandbox.kill()
    }
  }, 120_000)

  test('denyOut=[0.0.0.0/0] blocks all internet access', async () => {
    printTestHeader('Network Test: denyOut (deny all)')

    // Create sandbox with deny all (whitelist mode)
    console.log('1. Creating sandbox with denyOut=["0.0.0.0/0"]...')
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
      network: {
        denyOut: ['0.0.0.0/0'],
        // No allowOut = deny all
      },
    })
    const createTime = Date.now() - createStart
    console.log(`   Sandbox created: ${sandbox.sandboxId} (${createTime}ms)`)

    try {
      // Test: VM should NOT be able to reach 8.8.8.8
      console.log('\n2. Testing connectivity to 8.8.8.8...')
      const canReach = await testConnectivity(sandbox, '8.8.8.8', 3)

      expect(canReach).toBe(false)
      console.log('\n=== Test Passed: denyOut blocks internet access ===')
    } finally {
      console.log('\n3. Cleaning up...')
      await sandbox.kill()
    }
  }, 120_000)

  test('allowOut whitelist allows only specified IPs', async () => {
    printTestHeader('Network Test: allowOut whitelist [8.8.8.8]')

    // Create sandbox with IP whitelist (only 8.8.8.8 allowed)
    console.log('1. Creating sandbox with allowOut=["8.8.8.8"], denyOut=["0.0.0.0/0"]...')
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
      network: {
        allowOut: ['8.8.8.8'],
        denyOut: ['0.0.0.0/0'],
      },
    })
    const createTime = Date.now() - createStart
    console.log(`   Sandbox created: ${sandbox.sandboxId} (${createTime}ms)`)

    try {
      // Test 1: VM should be able to reach 8.8.8.8 (in allowlist)
      console.log('\n2. Testing connectivity to 8.8.8.8 (allowed)...')
      const canReach8888 = await testConnectivity(sandbox, '8.8.8.8', 5)
      console.log(`   Can reach 8.8.8.8: ${canReach8888}`)

      // Test 2: VM should NOT be able to reach 1.1.1.1 (not in allowlist)
      console.log('\n3. Testing connectivity to 1.1.1.1 (blocked)...')
      const canReach1111 = await testConnectivity(sandbox, '1.1.1.1', 3)
      console.log(`   Can reach 1.1.1.1: ${canReach1111}`)

      // Assertions
      expect(canReach8888).toBe(true)
      expect(canReach1111).toBe(false)

      console.log('\n=== Test Passed: allowOut whitelist allows only specified IPs ===')
    } finally {
      console.log('\n4. Cleaning up...')
      await sandbox.kill()
    }
  }, 120_000)

  test('allowedDomains whitelist allows only specified domains', async () => {
    printTestHeader('Network Test: allowedDomains whitelist [one.one.one.one]')

    // Create sandbox with domain whitelist (only one.one.one.one allowed)
    // NOTE: allowOut includes 8.8.8.8 for DNS - VM template uses 8.8.8.8 as default DNS
    // We test that 9.9.9.9 (Quad9) is blocked
    console.log(
      '1. Creating sandbox with allowedDomains=["one.one.one.one"], allowOut=["8.8.8.8"], denyOut=["0.0.0.0/0"]...'
    )
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
      network: {
        allowedDomains: ['one.one.one.one'],
        allowOut: ['8.8.8.8'], // VM uses 8.8.8.8 as default DNS
        denyOut: ['0.0.0.0/0'],
      },
    })
    const createTime = Date.now() - createStart
    console.log(`   Sandbox created: ${sandbox.sandboxId} (${createTime}ms)`)

    try {
      // Test 1: VM should be able to reach one.one.one.one (in allowlist)
      console.log('\n2. Testing connectivity to one.one.one.one (allowed)...')
      const canReachAllowed = await testConnectivity(sandbox, 'one.one.one.one', 5)
      console.log(`   Can reach one.one.one.one: ${canReachAllowed}`)

      // Test 2: VM should NOT be able to reach 9.9.9.9 (not in domain allowlist, not in allowOut)
      console.log('\n3. Testing connectivity to 9.9.9.9 (blocked)...')
      const canReach9999 = await testConnectivity(sandbox, '9.9.9.9', 3)
      console.log(`   Can reach 9.9.9.9: ${canReach9999}`)

      // Assertions
      expect(canReachAllowed).toBe(true)
      expect(canReach9999).toBe(false)

      console.log('\n=== Test Passed: allowedDomains whitelist works ===')
    } finally {
      console.log('\n4. Cleaning up...')
      await sandbox.kill()
    }
  }, 120_000)

  test('wildcard domain pattern matches subdomains', async () => {
    printTestHeader('Network Test: wildcard domain [*.github.com]')

    // Create sandbox with wildcard domain whitelist
    // NOTE: allowOut includes 8.8.8.8 for DNS - VM template uses 8.8.8.8 as default DNS
    console.log(
      '1. Creating sandbox with allowedDomains=["*.github.com"], allowOut=["8.8.8.8"], denyOut=["0.0.0.0/0"]...'
    )
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
      network: {
        allowedDomains: ['*.github.com'],
        allowOut: ['8.8.8.8'], // VM uses 8.8.8.8 as default DNS
        denyOut: ['0.0.0.0/0'],
      },
    })
    const createTime = Date.now() - createStart
    console.log(`   Sandbox created: ${sandbox.sandboxId} (${createTime}ms)`)

    try {
      // Test 1: VM should be able to reach api.github.com (matches *.github.com)
      console.log('\n2. Testing connectivity to api.github.com (should match *.github.com)...')
      const result = await sandbox.commands.run(
        'curl -s -m 10 -o /dev/null -w "%{http_code}" https://api.github.com 2>&1; echo "EXIT:$?"',
        { timeoutMs: 15000 }
      )
      const exitMatch = result.stdout.match(/EXIT:(\d+)/)
      const exitCode = exitMatch ? parseInt(exitMatch[1]) : -1
      const canReachGithub = exitCode === 0 || exitCode === 60
      console.log(`   api.github.com: exit=${exitCode} (${canReachGithub ? 'REACHABLE' : 'UNREACHABLE'})`)

      // Test 2: VM should NOT be able to reach google.com (not in domain allowlist)
      console.log('\n3. Testing connectivity to google.com (blocked)...')
      const canReachGoogle = await testConnectivity(sandbox, 'google.com', 3)
      console.log(`   Can reach google.com: ${canReachGoogle}`)

      // Assertions
      expect(canReachGithub).toBe(true)
      expect(canReachGoogle).toBe(false)

      console.log('\n=== Test Passed: wildcard domain pattern works ===')
    } finally {
      console.log('\n4. Cleaning up...')
      await sandbox.kill()
    }
  }, 120_000)

  test('domain + CIDR allowlists work together', async () => {
    printTestHeader('Network Test: domain + CIDR combined')

    // Create sandbox with both domain and CIDR whitelist
    // NOTE: 8.8.8.8 for DNS (VM default), 1.1.1.1 as allowed CIDR
    console.log(
      '1. Creating sandbox with allowedDomains=["dns.google"], allowOut=["1.1.1.1", "8.8.8.8"], denyOut=["0.0.0.0/0"]...'
    )
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
      network: {
        allowedDomains: ['dns.google'],
        allowOut: ['1.1.1.1', '8.8.8.8'], // 8.8.8.8 for DNS, 1.1.1.1 as allowed CIDR
        denyOut: ['0.0.0.0/0'],
      },
    })
    const createTime = Date.now() - createStart
    console.log(`   Sandbox created: ${sandbox.sandboxId} (${createTime}ms)`)

    try {
      // Test 1: VM should be able to reach 1.1.1.1 (in CIDR allowlist)
      console.log('\n2. Testing connectivity to 1.1.1.1 (CIDR allowed)...')
      const canReach1111 = await testConnectivity(sandbox, '1.1.1.1', 5)
      console.log(`   Can reach 1.1.1.1: ${canReach1111}`)

      // Test 2: VM should be able to reach dns.google (in domain allowlist)
      console.log('\n3. Testing connectivity to dns.google (domain allowed)...')
      const result = await sandbox.commands.run(
        'curl -s -m 10 -o /dev/null -w "%{http_code}" https://dns.google 2>&1; echo "EXIT:$?"',
        { timeoutMs: 15000 }
      )
      const exitMatch = result.stdout.match(/EXIT:(\d+)/)
      const exitCode = exitMatch ? parseInt(exitMatch[1]) : -1
      const canReachDnsGoogle = exitCode === 0 || exitCode === 60
      console.log(`   dns.google: exit=${exitCode} (${canReachDnsGoogle ? 'REACHABLE' : 'UNREACHABLE'})`)

      // Test 3: VM should NOT be able to reach 9.9.9.9 (not in any allowlist)
      console.log('\n4. Testing connectivity to 9.9.9.9 (blocked)...')
      const canReach9999 = await testConnectivity(sandbox, '9.9.9.9', 3)
      console.log(`   Can reach 9.9.9.9: ${canReach9999}`)

      // Assertions
      expect(canReach1111).toBe(true)
      expect(canReachDnsGoogle).toBe(true)
      expect(canReach9999).toBe(false)

      console.log('\n=== Test Passed: domain + CIDR allowlists work together ===')
    } finally {
      console.log('\n5. Cleaning up...')
      await sandbox.kill()
    }
  }, 120_000)

  test('network config persists across pause/resume', async () => {
    printTestHeader('Network Test: pause/resume persistence with domain allowlist')

    // Create sandbox with domain whitelist (only one.one.one.one allowed)
    // NOTE: allowOut includes 8.8.8.8 for DNS - VM template uses 8.8.8.8 as default DNS
    // We test that 9.9.9.9 (Quad9) is blocked
    console.log(
      '1. Creating sandbox with allowedDomains=["one.one.one.one"], allowOut=["8.8.8.8"], denyOut=["0.0.0.0/0"]...'
    )
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
      autoPause: false,
      network: {
        allowedDomains: ['one.one.one.one'],
        allowOut: ['8.8.8.8'], // VM uses 8.8.8.8 as default DNS
        denyOut: ['0.0.0.0/0'],
      },
    })
    console.log(`   Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Verify allowed domain is reachable BEFORE pause
      console.log('\n2. Testing connectivity BEFORE pause...')
      console.log('   Testing one.one.one.one (allowed)...')
      const canReachAllowedBefore = await testConnectivity(sandbox, 'one.one.one.one', 5)
      console.log(`   Can reach one.one.one.one: ${canReachAllowedBefore}`)

      console.log('   Testing 9.9.9.9 (blocked)...')
      const canReachBlockedBefore = await testConnectivity(sandbox, '9.9.9.9', 3)
      console.log(`   Can reach 9.9.9.9: ${canReachBlockedBefore}`)

      expect(canReachAllowedBefore).toBe(true)
      expect(canReachBlockedBefore).toBe(false)

      // Pause
      console.log('\n3. Pausing sandbox...')
      const pauseStart = Date.now()
      await sandbox.pause()
      console.log(`   Sandbox paused (${Date.now() - pauseStart}ms)`)

      // Wait a bit for pause to complete
      await new Promise((r) => setTimeout(r, 2000))

      // Resume
      console.log('\n4. Resuming sandbox...')
      const resumeStart = Date.now()
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      console.log(`   Sandbox resumed (${Date.now() - resumeStart}ms)`)

      // Verify network config persisted - allowed domain still reachable, blocked still blocked
      console.log('\n5. Testing connectivity AFTER resume...')
      console.log('   Testing one.one.one.one (should still be allowed)...')
      const canReachAllowedAfter = await testConnectivity(resumed, 'one.one.one.one', 5)
      console.log(`   Can reach one.one.one.one: ${canReachAllowedAfter}`)

      console.log('   Testing 9.9.9.9 (should still be blocked)...')
      const canReachBlockedAfter = await testConnectivity(resumed, '9.9.9.9', 3)
      console.log(`   Can reach 9.9.9.9: ${canReachBlockedAfter}`)

      expect(canReachAllowedAfter).toBe(true)
      expect(canReachBlockedAfter).toBe(false)

      console.log('\n=== Test Passed: network config persists across pause/resume ===')

      // Cleanup
      await resumed.kill()
    } catch (e) {
      // Cleanup on error
      try {
        await sandbox.kill()
      } catch {}
      throw e
    }
  }, 180_000)
})
