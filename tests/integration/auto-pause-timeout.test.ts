/**
 * Auto-Pause Timeout Test
 *
 * Verifies that sandboxes created with autoPause=true respect the timeout value
 * and don't auto-pause immediately.
 *
 * Bug: Sandboxes were auto-pausing immediately instead of waiting for the timeout.
 *
 * Run:
 *   npx vitest run tests/integration/auto-pause-timeout.test.ts
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

describe('Auto-Pause Timeout', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('sandbox with autoPause should respect timeout (not pause immediately)', async () => {
    const TIMEOUT_SECONDS = 60  // 1 minute timeout for testing
    const CHECK_INTERVAL_SECONDS = 5
    const CHECKS_BEFORE_TIMEOUT = 6  // Check 6 times (30 seconds) before timeout

    printTestHeader('Auto-Pause Timeout Verification Test')

    console.log(`\n1. Creating sandbox with autoPause=true and ${TIMEOUT_SECONDS}s timeout...`)
    const createStart = Date.now()

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: TIMEOUT_SECONDS * 1000,
      autoPause: true,
    })

    const createDuration = ((Date.now() - createStart) / 1000).toFixed(1)
    console.log(`   Sandbox created: ${sandbox.sandboxId} (took ${createDuration}s)`)
    expect(sandbox.sandboxId).toBeDefined()

    try {
      // 2. Verify sandbox is running immediately after creation
      console.log('\n2. Verifying sandbox is running immediately after creation...')
      const infoAfterCreate = await sandbox.getInfo()
      console.log(`   State: ${infoAfterCreate.state}`)
      console.log(`   Started at: ${infoAfterCreate.startedAt}`)
      console.log(`   End at: ${infoAfterCreate.endAt}`)
      expect(infoAfterCreate.state).toBe('running')

      // 3. Run a command to verify sandbox is functional
      console.log('\n3. Running command to verify sandbox is functional...')
      const result = await sandbox.commands.run('echo "sandbox is alive"', {
        timeoutMs: 30_000,
      })
      console.log(`   Output: ${result.stdout.trim()}`)
      expect(result.exitCode).toBe(0)

      // 4. Check sandbox state multiple times BEFORE timeout expires
      console.log(`\n4. Checking sandbox remains running for ${CHECKS_BEFORE_TIMEOUT * CHECK_INTERVAL_SECONDS}s...`)

      for (let i = 1; i <= CHECKS_BEFORE_TIMEOUT; i++) {
        await new Promise(resolve => setTimeout(resolve, CHECK_INTERVAL_SECONDS * 1000))

        const elapsed = i * CHECK_INTERVAL_SECONDS
        const info = await sandbox.getInfo()
        console.log(`   [${elapsed}s] State: ${info.state}`)

        // Sandbox should still be running (not paused yet)
        if (info.state !== 'running') {
          throw new Error(
            `BUG: Sandbox auto-paused after only ${elapsed}s, expected to run for ${TIMEOUT_SECONDS}s. ` +
            `State: ${info.state}`
          )
        }
      }

      console.log(`   Sandbox correctly remained running for ${CHECKS_BEFORE_TIMEOUT * CHECK_INTERVAL_SECONDS}s`)

      // 5. Now wait for timeout to actually expire
      const remainingTime = TIMEOUT_SECONDS - (CHECKS_BEFORE_TIMEOUT * CHECK_INTERVAL_SECONDS)
      console.log(`\n5. Waiting ${remainingTime + 30}s for auto-pause to trigger...`)

      let pauseDetected = false
      const maxWait = remainingTime + 60  // Extra buffer for pause operation

      for (let i = 1; i <= maxWait; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000))

        try {
          const info = await sandbox.getInfo()

          if (['pausing', 'paused'].includes(info.state)) {
            const totalElapsed = (CHECKS_BEFORE_TIMEOUT * CHECK_INTERVAL_SECONDS) + i
            console.log(`   Auto-pause detected after ~${totalElapsed}s total: ${info.state}`)
            pauseDetected = true

            // Wait for pause to complete if still pausing
            if (info.state === 'pausing') {
              console.log(`   Waiting for pause operation to complete...`)
              for (let j = 1; j <= 120; j++) {
                await new Promise(resolve => setTimeout(resolve, 1000))
                const checkInfo = await sandbox.getInfo()
                if (checkInfo.state === 'paused') {
                  console.log(`   Pause completed after ${j}s`)
                  break
                }
              }
            }
            break
          }

          if (i % 10 === 0) {
            console.log(`   [+${i}s] Still running, waiting for auto-pause...`)
          }
        } catch (e) {
          // Sandbox might be transitioning
        }
      }

      expect(pauseDetected).toBe(true)

      // 6. Verify sandbox is now paused (not killed)
      console.log('\n6. Verifying sandbox is paused (not killed)...')
      const finalInfo = await sandbox.getInfo()
      console.log(`   Final state: ${finalInfo.state}`)
      expect(finalInfo.state).toBe('paused')

      // 7. Resume and verify it works
      console.log('\n7. Resuming sandbox to verify it was paused correctly...')
      const resumed = await Sandbox.connect(sandbox.sandboxId, {
        ...gatewayConfig,
        timeoutMs: 60_000,
      })

      const resumedInfo = await resumed.getInfo()
      console.log(`   State after resume: ${resumedInfo.state}`)
      expect(resumedInfo.state).toBe('running')

      // 8. Run command after resume
      const result2 = await resumed.commands.run('echo "resumed successfully"', {
        timeoutMs: 30_000,
      })
      console.log(`   Output: ${result2.stdout.trim()}`)
      expect(result2.exitCode).toBe(0)

      console.log('\n=== Test Passed ===')
      console.log('Sandbox correctly respected the timeout before auto-pausing.')

      // Cleanup
      await resumed.kill()
      console.log('Sandbox killed')

    } catch (error) {
      // Try to kill sandbox on error
      try {
        await sandbox.kill()
      } catch (e) {
        // Ignore cleanup errors
      }
      throw error
    }
  }, 300_000)  // 5 minute test timeout

  test('verify timeout value is passed correctly to gateway', async () => {
    const TIMEOUT_SECONDS = 120  // 2 minutes

    printTestHeader('Timeout Value Verification Test')

    console.log(`\n1. Creating sandbox with ${TIMEOUT_SECONDS}s timeout...`)

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: TIMEOUT_SECONDS * 1000,
      autoPause: true,
    })

    console.log(`   Sandbox created: ${sandbox.sandboxId}`)

    try {
      // 2. Get sandbox info and verify endAt is reasonable
      console.log('\n2. Checking sandbox endAt time...')
      const info = await sandbox.getInfo()

      const startedAt = new Date(info.startedAt)
      const endAt = new Date(info.endAt)
      const durationSeconds = (endAt.getTime() - startedAt.getTime()) / 1000

      console.log(`   Started at: ${info.startedAt}`)
      console.log(`   End at: ${info.endAt}`)
      console.log(`   Duration: ${durationSeconds}s (expected: ~${TIMEOUT_SECONDS}s)`)

      // Allow some tolerance (±30 seconds) for processing time
      const tolerance = 30
      expect(durationSeconds).toBeGreaterThan(TIMEOUT_SECONDS - tolerance)
      expect(durationSeconds).toBeLessThan(TIMEOUT_SECONDS + tolerance)

      console.log(`   Timeout correctly set to ~${TIMEOUT_SECONDS}s`)

      console.log('\n=== Test Passed ===')

      // Cleanup
      await sandbox.kill()
      console.log('Sandbox killed')

    } catch (error) {
      try {
        await sandbox.kill()
      } catch (e) {
        // Ignore
      }
      throw error
    }
  }, 60_000)
})
