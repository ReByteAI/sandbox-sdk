/**
 * Sandbox Integration Tests
 *
 * Tests core sandbox lifecycle operations:
 * - Create sandbox
 * - Get info
 * - Kill sandbox
 * - Multiple sandboxes (reuse test)
 * - Parallel sandboxes
 *
 * Run:
 *   npx vitest run tests/integration/sandbox.test.ts
 *
 * With large template (4GB):
 *   TEST_TEMPLATE=large npx vitest run tests/integration/sandbox.test.ts
 *
 * Against production:
 *   TEST_ENV=prod npx vitest run tests/integration/sandbox.test.ts
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

// Helper to check and print storage paths for debugging
// NFS cache is shared between dev and prod, so paths are accessible from dev machine
async function printStoragePaths(templateId: string, sandboxId?: string) {
  const { existsSync, readdirSync } = await import('fs')
  const cacheDir = '/mnt/nfs-cache/cache'  // Shared NFS (accessible from dev)

  console.log('\n--- Storage Paths (NFS shared between dev/prod) ---')

  const templatePath = `${cacheDir}/${templateId}`
  const templateExists = existsSync(templatePath)
  console.log(`   Template cache: ${templatePath}/ [${templateExists ? 'EXISTS' : 'NOT FOUND'}]`)

  if (templateExists) {
    try {
      const files = readdirSync(templatePath)
      console.log(`   Template files: ${files.join(', ')}`)
    } catch (e) {
      console.log(`   Template files: (unable to list)`)
    }
  }
}

describe('Sandbox Lifecycle', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('create, get info, and kill sandbox', async () => {
    printTestHeader('Create/Info/Kill Test')

    // 0. Remove template from local (dev only) - tests GCS auto-download
    // NOTE: Commented out to speed up tests - template download from GCS can be slow
    // if (process.env.TEST_ENV !== 'prod') {
    //   console.log('\n0. Removing template from local storage (tests GCS auto-download)...')
    //   const { execSync } = await import('child_process')
    //   // Remove both template files and shared cache
    //   const paths = [
    //     `/mnt/storage/.microsandbox/templates/${TEMPLATE_ID}`,  // template files
    //     `/mnt/storage/.microsandbox/cache/${TEMPLATE_ID}`,      // shared cache
    //   ]
    //   for (const path of paths) {
    //     try {
    //       execSync(`sudo rm -rf ${path}`, { stdio: 'inherit' })
    //       console.log(`   Removed: ${path}`)
    //     } catch (e) {
    //       console.log(`   Not found: ${path}`)
    //     }
    //   }
    // }

    // 1. Create sandbox
    console.log('\n1. Creating sandbox...')
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    const createTime = Date.now() - createStart
    console.log(`   Sandbox created: ${sandbox.sandboxId} (${createTime}ms)`)
    expect(sandbox.sandboxId).toBeDefined()
    expect(sandbox.sandboxId).not.toBe('')

    // 2. Get sandbox info
    console.log('\n2. Getting sandbox info...')
    const info = await sandbox.getInfo()
    console.log(`   Sandbox info:`)
    console.log(`     - sandboxId: ${info.sandboxId}`)
    console.log(`     - templateId: ${info.templateId}`)
    console.log(`     - state: ${info.state}`)
    console.log(`     - startedAt: ${info.startedAt}`)
    expect(info.sandboxId).toBe(sandbox.sandboxId)
    expect(info.state).toBe('running')

    // 3. Kill sandbox
    console.log('\n3. Killing sandbox...')
    await sandbox.kill()
    console.log('   Sandbox killed successfully')

    await printStoragePaths(TEMPLATE_ID, sandbox.sandboxId)
    console.log('\n=== Test Passed ===')
  }, 60_000)

  test('create and kill multiple sandboxes (reuse test)', async () => {
    printTestHeader('Multiple Sandboxes Reuse Test')

    const iterations = 3
    for (let i = 1; i <= iterations; i++) {
      console.log(`\n--- Iteration ${i}/${iterations} ---`)

      // Create sandbox
      console.log('  Creating sandbox...')
      const createStart = Date.now()
      const sandbox = await Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      const createTime = Date.now() - createStart
      console.log(`  Sandbox created: ${sandbox.sandboxId} (${createTime}ms)`)
      expect(sandbox.sandboxId).toBeDefined()

      // Kill sandbox
      console.log('  Killing sandbox...')
      await sandbox.kill()
      console.log('  Sandbox killed successfully')
    }

    await printStoragePaths(TEMPLATE_ID)
    console.log('\n=== Test Passed ===')
  }, 120_000)

  test('parallel sandboxes with long-running commands', async () => {
    printTestHeader('Parallel Sandboxes Test')

    const NUM_SANDBOXES = 3
    const sandboxes: Sandbox[] = []

    try {
      // 1. Create 3 sandboxes in parallel
      console.log(`\n1. Creating ${NUM_SANDBOXES} sandboxes in parallel...`)
      const createStart = Date.now()
      const createPromises = Array.from({ length: NUM_SANDBOXES }, (_, i) => {
        const start = Date.now()
        return Sandbox.create(TEMPLATE_ID, {
          ...gatewayConfig,
          timeoutMs: 300_000,
        }).then(sandbox => {
          const elapsed = Date.now() - start
          console.log(`   Sandbox ${i + 1} created: ${sandbox.sandboxId} (${elapsed}ms)`)
          return sandbox
        })
      })

      sandboxes.push(...await Promise.all(createPromises))
      const createTime = Date.now() - createStart
      console.log(`   All ${NUM_SANDBOXES} sandboxes created in ${createTime}ms`)

      // 2. Run long-running commands on all sandboxes in parallel (~10s each)
      console.log('\n2. Running 10s commands on all sandboxes in parallel...')
      const cmdStart = Date.now()
      const commandPromises = sandboxes.map((sandbox, i) =>
        sandbox.commands.run(
          // Command that runs for ~10 seconds with output
          'for j in 1 2 3 4 5 6 7 8 9 10; do echo "sandbox-'+ (i + 1) +' iteration $j"; sleep 1; done',
          { timeoutMs: 60_000 }
        ).then(result => {
          console.log(`   Sandbox ${i + 1} (${sandbox.sandboxId}): exit=${result.exitCode}, lines=${result.stdout.trim().split('\n').length}`)
          return result
        })
      )

      const results = await Promise.all(commandPromises)
      const cmdTime = Date.now() - cmdStart
      console.log(`   All commands completed in ${cmdTime}ms`)

      // Verify all commands succeeded
      for (let i = 0; i < results.length; i++) {
        expect(results[i].exitCode).toBe(0)
        expect(results[i].stdout).toContain('iteration 10')
      }
      console.log('   All commands succeeded')

      // 3. Kill all sandboxes in parallel
      console.log('\n3. Killing all sandboxes in parallel...')
      const killStart = Date.now()
      await Promise.all(sandboxes.map((sandbox, i) =>
        sandbox.kill().then(() => {
          console.log(`   Sandbox ${i + 1} killed`)
        })
      ))
      const killTime = Date.now() - killStart
      console.log(`   All sandboxes killed in ${killTime}ms`)

      await printStoragePaths(TEMPLATE_ID)
      console.log('\n=== Test Passed ===')
    } catch (error) {
      // Cleanup on error
      console.log('\nError occurred, cleaning up...')
      await Promise.allSettled(sandboxes.map(s => s.kill()))
      throw error
    }
  }, 180_000)

  test('sandbox timeout expiration', async () => {
    printTestHeader('Sandbox Timeout Expiration Test')

    const TIMEOUT_SECONDS = 20
    const WAIT_SECONDS = 40  // Wait longer to account for cleanup task (runs every 10s)

    // 1. Create sandbox with short timeout (20 seconds)
    console.log(`\n1. Creating sandbox with ${TIMEOUT_SECONDS}s timeout...`)
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: TIMEOUT_SECONDS * 1000,
    })
    const createTime = Date.now() - createStart
    const sandboxId = sandbox.sandboxId
    console.log(`   Sandbox created: ${sandboxId} (${createTime}ms)`)
    expect(sandboxId).toBeDefined()

    // 2. Verify sandbox is running
    console.log('\n2. Verifying sandbox is running...')
    const info = await sandbox.getInfo()
    console.log(`   State: ${info.state}`)
    expect(info.state).toBe('running')

    // 3. Wait for timeout to expire
    console.log(`\n3. Waiting ${WAIT_SECONDS}s for timeout to expire...`)
    for (let i = 1; i <= WAIT_SECONDS; i++) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (i % 10 === 0) {
        console.log(`   ${i}s elapsed...`)
      }
    }

    // 4. Verify sandbox is no longer running
    console.log('\n4. Verifying sandbox is no longer running...')
    try {
      const isRunning = await sandbox.isRunning()
      console.log(`   isRunning: ${isRunning}`)
      expect(isRunning).toBe(false)
    } catch (error: unknown) {
      const err = error as Error
      console.log(`   Got error (sandbox is gone): ${err.message}`)
    }

    await printStoragePaths(TEMPLATE_ID, sandboxId)
    console.log('\n=== Test Passed ===')
  }, 60_000)
})
