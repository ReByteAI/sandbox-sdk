/**
 * DD Bug Replication Test
 *
 * Replicates the NBD hang bug after pause/resume:
 * - Create VM → Pause → Resume → Run dd (1MB) → Stop
 * - Multiple iterations to catch flaky behavior
 * - 10s timeout per dd command, fail early
 *
 * Run:
 *   npx vitest run tests/integration/dd-bug.test.ts
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

const ITERATIONS = 20
const DD_TIMEOUT_MS = 10_000  // 10s timeout per dd command

describe('DD Bug Replication', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('pause/resume then dd - multiple iterations', async () => {
    printTestHeader('DD Bug Replication Test')

    for (let i = 1; i <= ITERATIONS; i++) {
      console.log(`\n=== Iteration ${i}/${ITERATIONS} ===`)

      // 1. Create sandbox
      console.log('1. Creating sandbox...')
      const createStart = Date.now()
      const sandbox = await Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 60_000,
      })
      console.log(`   Created: ${sandbox.sandboxId} (${Date.now() - createStart}ms)`)

      // 2. Pause
      console.log('2. Pausing...')
      const pauseStart = Date.now()
      await sandbox.pause()
      console.log(`   Paused (${Date.now() - pauseStart}ms)`)

      // 3. Resume (via connect)
      console.log('3. Resuming...')
      const resumeStart = Date.now()
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 60_000,
      })
      console.log(`   Resumed (${Date.now() - resumeStart}ms)`)

      // 4. Run dd (1MB) - this is where the hang happens
      console.log('4. Running dd (1MB)...')
      const ddStart = Date.now()
      try {
        const result = await resumed.commands.run(
          'dd if=/dev/zero of=/tmp/test.bin bs=1M count=1 conv=fsync 2>&1',
          { timeoutMs: DD_TIMEOUT_MS }
        )
        const ddTime = Date.now() - ddStart
        console.log(`   dd completed: exit=${result.exitCode} (${ddTime}ms)`)
        console.log(`   output: ${result.stdout.trim()}`)

        if (result.exitCode !== 0) {
          throw new Error(`dd failed with exit code ${result.exitCode}`)
        }
      } catch (error: unknown) {
        const err = error as Error
        console.error(`   DD FAILED: ${err.message}`)

        // Kill sandbox before failing
        try {
          await resumed.kill()
        } catch {}

        throw new Error(`Iteration ${i}: dd failed after ${Date.now() - ddStart}ms - ${err.message}`)
      }

      // 5. Stop
      console.log('5. Killing sandbox...')
      await resumed.kill()
      console.log('   Done')
    }

    console.log(`\n=== All ${ITERATIONS} iterations passed ===`)
  }, ITERATIONS * 30_000)  // 30s per iteration
})
