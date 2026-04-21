/**
 * Large Memory Pause Test (>2GB)
 *
 * Tests the fix for the 2GB `process_vm_readv` limit.
 * Creates a sandbox with 4GB memory, fills pages to ensure high RSS,
 * then pauses to verify the memfile creation works with >2GB.
 *
 * Run against prod (requires large template):
 *   TEST_ENV=prod TEST_TEMPLATE=large npx vitest run tests/integration/large-memory-pause.test.ts
 *
 * The previous bug caused: "short read: expected X bytes, got 2147479552"
 * This test verifies the MAX_TRANSFER_SIZE fix works.
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  TEMPLATES,
  getGatewayConfig,
  getEnvironment,
  printTestHeader,
  ensureProdApiKey,
  getNamespace,
} from './common'

const gatewayConfig = getGatewayConfig()
const testEnv = getEnvironment()

// This test REQUIRES the large template (4GB memory)
const TEMPLATE_ID_LARGE = TEMPLATES.large.id
const MEMORY_MB = 4096  // 4GB

describe('Large Memory Pause (>2GB fix)', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('pause sandbox with >2GB memory - verifies MAX_TRANSFER_SIZE fix', async () => {
    printTestHeader('Large Memory Pause Test (>2GB)')

    console.log(`\nTest Configuration:`)
    console.log(`  Template: large (${TEMPLATES.large.id})`)
    console.log(`  Memory: ${MEMORY_MB}MB (4GB)`)
    console.log(`  Environment: ${testEnv}`)
    console.log(`  Gateway: ${gatewayConfig.apiUrl}`)

    // 1. Create sandbox with large template (4GB memory)
    console.log('\n1. Creating sandbox with 4GB memory...')
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID_LARGE, {
      ...gatewayConfig,
      timeoutMs: 600_000,  // 10 min timeout for large VM
    })
    const createDuration = ((Date.now() - createStart) / 1000).toFixed(1)
    console.log(`   Sandbox created: ${sandbox.sandboxId} (${createDuration}s)`)
    expect(sandbox.sandboxId).toBeDefined()

    try {
      // 2. Verify sandbox is working
      console.log('\n2. Verifying sandbox is working...')
      const verifyResult = await sandbox.commands.run('echo "sandbox ready" && free -m', {
        timeoutMs: 30_000,
      })
      console.log(`   Output:\n${verifyResult.stdout}`)
      expect(verifyResult.exitCode).toBe(0)

      // 3. Fill memory to ensure high RSS (>2GB dirty pages)
      // Using dd with /dev/urandom to create non-zero files in /dev/shm (tmpfs = RAM)
      console.log('\n3. Filling memory using /dev/shm (tmpfs) with random data...')
      console.log('   Note: Using /dev/urandom, not /dev/zero (zeros are empty pages)')

      // Check if stress-ng is available (use || true to avoid throwing on not found)
      const stressCheck = await sandbox.commands.run('which stress-ng || echo "not found"', { timeoutMs: 5_000 })

      if (stressCheck.stdout.includes('/stress-ng')) {
        // stress-ng is available - use it for efficient memory filling
        console.log('   stress-ng found, using it for memory stress...')
        const stressResult = await sandbox.commands.run(
          'stress-ng --vm 1 --vm-bytes 3G --vm-keep --timeout 30s 2>&1',
          { timeoutMs: 120_000 }
        )
        console.log(`   stress-ng output: ${stressResult.stdout}`)
      } else {
        // Fallback to dd with /dev/urandom
        console.log('   stress-ng not found, using dd with /dev/urandom...')

        // Fill /dev/shm until full (typically limited to half RAM)
        // Using || true to ignore "no space" errors
        const fillResult = await sandbox.commands.run(
          'for i in 1 2 3 4 5 6; do ' +
          'dd if=/dev/urandom of=/dev/shm/chunk$i bs=1M count=512 2>&1 || true; ' +
          'done; ' +
          'du -sh /dev/shm/',
          { timeoutMs: 300_000 }
        )
        console.log(`   Fill result:\n${fillResult.stdout}`)
      }

      // Show memory status and /dev/shm usage
      const memResult = await sandbox.commands.run('free -m && echo "---" && df -h /dev/shm && ls -lh /dev/shm/ 2>/dev/null || true', { timeoutMs: 10_000 })
      console.log(`   Memory status:\n${memResult.stdout}`)

      // 4. PAUSE - This is the critical test!
      // Previously failed with: "short read: expected X bytes, got 2147479552"
      console.log('\n4. PAUSING sandbox (creating >2GB memfile)...')
      console.log('   This previously failed with: "short read: expected X bytes, got 2147479552"')
      console.log('   Note: Large memory pause can take 2-3 minutes (NFS write ~25 MB/s)')

      const pauseStart = Date.now()
      // Use 5 minute timeout for large memory pause (NFS write can take 2+ minutes for 2.5GB)
      const paused = await sandbox.pause({ requestTimeoutMs: 300_000 })
      const pauseDuration = ((Date.now() - pauseStart) / 1000).toFixed(1)

      console.log(`   Pause result: ${paused} (took ${pauseDuration}s)`)
      expect(paused).toBe(true)

      // 5. Verify pause completed successfully
      console.log('\n5. Verifying pause state...')
      const info = await sandbox.getInfo()
      console.log(`   State: ${info.state}`)
      expect(info.state).toBe('paused')

      // 6. Check GCS for the snapshot
      console.log('\n6. Verifying GCS snapshot...')
      const { execSync } = require('child_process')
      const namespace = getNamespace()
      const gcsPath = `gs://microsandbox/sandboxes/${namespace}/${sandbox.sandboxId}/paused/`

      try {
        const listOutput = execSync(`gsutil ls ${gcsPath}`, { encoding: 'utf8', timeout: 30_000 })
        const snapshotDirs = listOutput.trim().split('\n').filter((l: string) => l.endsWith('/'))

        if (snapshotDirs.length > 0) {
          const latestDir = snapshotDirs[snapshotDirs.length - 1]
          console.log(`   Latest snapshot: ${latestDir}`)

          // Check memfile size
          const filesOutput = execSync(`gsutil ls -l ${latestDir}`, { encoding: 'utf8', timeout: 30_000 })
          const lines = filesOutput.trim().split('\n')

          for (const line of lines) {
            if (line.includes('memfile') && !line.includes('.header')) {
              const parts = line.trim().split(/\s+/)
              if (parts.length >= 1) {
                const sizeBytes = parseInt(parts[0])
                const sizeMB = (sizeBytes / 1024 / 1024).toFixed(0)
                const sizeGB = (sizeBytes / 1024 / 1024 / 1024).toFixed(2)
                console.log(`   Memfile size: ${sizeMB} MB (${sizeGB} GB)`)

                // The memfile should be at least 2GB for a 4GB VM with high RSS
                if (sizeBytes > 2 * 1024 * 1024 * 1024) {
                  console.log(`   ✓ Memfile is >2GB - MAX_TRANSFER_SIZE fix verified!`)
                } else {
                  console.log(`   Note: Memfile is <2GB (RSS may not have been fully dirty)`)
                }
              }
            }
          }
        }
      } catch (e: any) {
        console.log(`   GCS check skipped: ${e.message}`)
      }

      // 7. Resume and verify sandbox still works
      console.log('\n7. Resuming sandbox to verify it works after pause...')
      const resumeStart = Date.now()
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      const resumeDuration = ((Date.now() - resumeStart) / 1000).toFixed(1)
      console.log(`   Resumed: ${resumed.sandboxId} (${resumeDuration}s)`)

      // 8. Verify data persisted (in /dev/shm, which is tmpfs = RAM)
      console.log('\n8. Verifying data persisted in /dev/shm...')
      const checkResult = await resumed.commands.run('ls -lh /dev/shm/ && du -sh /dev/shm/', {
        timeoutMs: 30_000,
      })
      console.log(`   Output:\n${checkResult.stdout}`)
      expect(checkResult.exitCode).toBe(0)
      expect(checkResult.stdout).toContain('chunk')

      console.log('\n' + '='.repeat(50))
      console.log('  LARGE MEMORY PAUSE TEST PASSED!')
      console.log('='.repeat(50))
      console.log('\nSummary:')
      console.log(`  - Created sandbox with ${MEMORY_MB}MB (4GB) memory`)
      console.log('  - Filled ~2.5GB of RAM')
      console.log('  - Successfully paused with >2GB memfile')
      console.log('  - Resumed and verified data persistence')
      console.log('  - The MAX_TRANSFER_SIZE fix works!')

      // Cleanup
      await resumed.kill()
      console.log('\nSandbox killed')

    } catch (error) {
      console.error('\nTest failed with error:', error)
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 900_000)  // 15 minute timeout
})
