/**
 * Template V2 Provisioning Test
 *
 * This test verifies provisioning features:
 * - User 'user' exists with sudo group
 * - Passwordless sudo works
 * - /code directory with 777 permissions owned by user
 * - /usr/local with 777 permissions
 * - /.microsandbox metadata file
 * - Swap enabled
 * - Chrony running as root
 *
 * Reference: docs/TEMPLATE_PROVISIONING_V2.md
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'

// Template ID from the build output
// Update this with the actual template ID after building
import { getTemplateId } from './common'
const TEMPLATE_ID = process.env.TEMPLATE_ID || getTemplateId()

// Gateway configuration
const gatewayConfig = {
  apiUrl: process.env.REBYTE_SANDBOX_API_URL || 'http://localhost:8080',
  apiKey: process.env.REBYTE_SANDBOX_API_KEY || 'test-key',
}

describe('Template V2 Provisioning', () => {
  // Skip if not running gateway tests
  const runTests = process.env.REBYTE_SANDBOX_GATEWAY_TEST === '1'

  test.skipIf(!runTests)('verify template v2 provisioning (user, directories, swap)', async () => {
    console.log('=== Template V2 Provisioning Test ===')
    console.log(`API URL: ${gatewayConfig.apiUrl}`)
    console.log(`Template ID: ${TEMPLATE_ID}`)

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 1. Verify 'user' exists with sudo group
      console.log('\n1. Checking user exists...')
      const userResult = await sandbox.commands.run('id user', { timeoutMs: 10_000 })
      console.log(`   Output: ${userResult.stdout.trim()}`)
      expect(userResult.exitCode).toBe(0)
      expect(userResult.stdout).toContain('uid=1000(user)')
      expect(userResult.stdout).toContain('sudo')

      // 2. Verify sudo works without password
      console.log('\n2. Checking passwordless sudo...')
      const sudoResult = await sandbox.commands.run('sudo -u user sudo whoami', { timeoutMs: 10_000 })
      console.log(`   Output: ${sudoResult.stdout.trim()}`)
      expect(sudoResult.exitCode).toBe(0)
      expect(sudoResult.stdout.trim()).toBe('root')

      // 3. Verify /code directory (777, owned by user)
      console.log('\n3. Checking /code directory...')
      const codeResult = await sandbox.commands.run('stat -c "%a %U:%G" /code', { timeoutMs: 10_000 })
      console.log(`   Output: ${codeResult.stdout.trim()}`)
      expect(codeResult.exitCode).toBe(0)
      expect(codeResult.stdout).toContain('777')
      expect(codeResult.stdout).toContain('user:user')

      // 4. Verify /usr/local is world-writable
      console.log('\n4. Checking /usr/local permissions...')
      const localResult = await sandbox.commands.run('stat -c "%a" /usr/local', { timeoutMs: 10_000 })
      console.log(`   Output: ${localResult.stdout.trim()}`)
      expect(localResult.exitCode).toBe(0)
      expect(localResult.stdout.trim()).toBe('777')

      // 5. Verify metadata file exists
      console.log('\n5. Checking /.microsandbox metadata...')
      const metaResult = await sandbox.commands.run('cat /.microsandbox', { timeoutMs: 10_000 })
      console.log(`   Output:\n${metaResult.stdout}`)
      expect(metaResult.exitCode).toBe(0)
      expect(metaResult.stdout).toContain('TEMPLATE_ID=')
      expect(metaResult.stdout).toContain('BUILD_ID=')

      // 6. Verify swap is enabled
      console.log('\n6. Checking swap is enabled...')
      const swapResult = await sandbox.commands.run('swapon --show', { timeoutMs: 10_000 })
      console.log(`   Output: ${swapResult.stdout.trim()}`)
      expect(swapResult.exitCode).toBe(0)
      expect(swapResult.stdout).toContain('/swap/swapfile')

      // 7. Verify chrony running as root
      console.log('\n7. Checking chrony runs as root...')
      const chronyResult = await sandbox.commands.run('ps -o user,comm | grep chronyd', { timeoutMs: 10_000 })
      console.log(`   Output: ${chronyResult.stdout.trim()}`)
      expect(chronyResult.stdout).toContain('root')

      // 8. Verify user can write to /code
      console.log('\n8. Checking user write access to /code...')
      const writeResult = await sandbox.commands.run(
        'sudo -u user bash -c "echo hello > /code/test.txt && cat /code/test.txt"',
        { timeoutMs: 10_000 }
      )
      console.log(`   Output: ${writeResult.stdout.trim()}`)
      expect(writeResult.exitCode).toBe(0)
      expect(writeResult.stdout.trim()).toBe('hello')

      console.log('\n=== Template V2 Provisioning Test Passed ===')
    } finally {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 120_000)

  test.skipIf(!runTests)('verify configure.sh ran successfully', async () => {
    console.log('=== Configure.sh Verification Test ===')
    console.log(`Template ID: ${TEMPLATE_ID}`)

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })

    try {
      // Check that configure.sh completed (metadata file should exist)
      const result = await sandbox.commands.run('cat /.microsandbox', { timeoutMs: 10_000 })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('TEMPLATE_ID=')
      expect(result.stdout).toContain('BUILD_ID=')
      expect(result.stdout).toContain('CREATED_AT=')

      console.log('Configure.sh completed successfully:')
      console.log(result.stdout)
    } finally {
      await sandbox.kill()
    }
  }, 60_000)
})
