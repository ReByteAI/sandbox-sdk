/**
 * Load test: Concurrent command execution within a single sandbox.
 *
 * Tests how a sandbox handles many concurrent commands.
 *
 * Usage:
 *   # Default concurrency (10)
 *   npx vitest run tests/integration/load-concurrent-commands.test.ts
 *
 *   # Custom concurrency
 *   CONCURRENCY=50 npx vitest run tests/integration/load-concurrent-commands.test.ts
 *
 *   # With large template
 *   TEST_TEMPLATE=large CONCURRENCY=100 npx vitest run tests/integration/load-concurrent-commands.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  printTestHeader,
} from './common'

// Configuration
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '10', 10)
const MAX_SLEEP_MS = parseInt(process.env.MAX_SLEEP_MS || '3000', 10)
const MIN_SLEEP_MS = parseInt(process.env.MIN_SLEEP_MS || '100', 10)
const CMD_TIMEOUT_MS = parseInt(process.env.CMD_TIMEOUT_MS || '60000', 10)

describe('Load Test: Concurrent Commands', () => {
  let sandbox: Sandbox

  beforeAll(async () => {
    printTestHeader('Load Test: Concurrent Commands')
    console.log(`  Concurrency: ${CONCURRENCY}`)
    console.log(`  Sleep range: ${MIN_SLEEP_MS}ms - ${MAX_SLEEP_MS}ms`)
    console.log(`  Command timeout: ${CMD_TIMEOUT_MS}ms`)
    console.log('')

    const config = getGatewayConfig()
    sandbox = await Sandbox.create(getTemplateId(), {
      ...config,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.id}`)
  }, 120_000)

  afterAll(async () => {
    if (sandbox) {
      await sandbox.kill()
      console.log('Sandbox killed')
    }
  }, 30_000)

  it(`should handle ${CONCURRENCY} concurrent sleep commands`, async () => {
    const startTime = Date.now()

    // Generate random sleep durations
    const sleepDurations = Array.from({ length: CONCURRENCY }, () =>
      Math.floor(Math.random() * (MAX_SLEEP_MS - MIN_SLEEP_MS) + MIN_SLEEP_MS)
    )

    console.log(`\nStarting ${CONCURRENCY} concurrent commands...`)
    console.log(`Sleep durations: min=${Math.min(...sleepDurations)}ms, max=${Math.max(...sleepDurations)}ms`)

    // Run all commands concurrently
    const promises = sleepDurations.map(async (durationMs, index) => {
      const sleepSec = (durationMs / 1000).toFixed(3)
      const cmdStart = Date.now()

      try {
        const result = await sandbox.commands.run(`sleep ${sleepSec} && echo "done-${index}"`, {
          timeoutMs: CMD_TIMEOUT_MS,
        })
        const cmdEnd = Date.now()

        return {
          index,
          success: result.exitCode === 0,
          exitCode: result.exitCode,
          expectedDurationMs: durationMs,
          actualDurationMs: cmdEnd - cmdStart,
          stdout: result.stdout.trim(),
        }
      } catch (error: any) {
        return {
          index,
          success: false,
          error: error.message,
          expectedDurationMs: durationMs,
          actualDurationMs: Date.now() - cmdStart,
        }
      }
    })

    const results = await Promise.all(promises)
    const endTime = Date.now()
    const totalDuration = endTime - startTime

    // Analyze results
    const successful = results.filter(r => r.success)
    const failed = results.filter(r => !r.success)

    console.log(`\n=== Results ===`)
    console.log(`Total time: ${totalDuration}ms`)
    console.log(`Successful: ${successful.length}/${CONCURRENCY}`)
    console.log(`Failed: ${failed.length}/${CONCURRENCY}`)

    if (successful.length > 0) {
      const durations = successful.map(r => r.actualDurationMs)
      console.log(`Durations: min=${Math.min(...durations)}ms, max=${Math.max(...durations)}ms, avg=${Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)}ms`)
    }

    if (failed.length > 0) {
      console.log(`\nFailed commands:`)
      failed.forEach(f => console.log(`  #${f.index}: ${(f as any).error || `exit code ${(f as any).exitCode}`}`))
    }

    // Verify all commands succeeded
    expect(failed.length).toBe(0)
    expect(successful.length).toBe(CONCURRENCY)

    // Verify each command returned expected output
    for (const result of successful) {
      expect(result.stdout).toBe(`done-${result.index}`)
    }

    // The total time should be roughly the max sleep duration (parallel execution)
    // Allow some overhead (2x the max sleep time)
    const maxExpectedDuration = MAX_SLEEP_MS * 2 + 10_000 // extra buffer for command overhead
    console.log(`\nParallelism check: total=${totalDuration}ms, maxExpected=${maxExpectedDuration}ms`)
    expect(totalDuration).toBeLessThan(maxExpectedDuration)

  }, 120_000)

  it(`should handle ${CONCURRENCY} concurrent echo commands (fast)`, async () => {
    const startTime = Date.now()

    console.log(`\nStarting ${CONCURRENCY} concurrent echo commands...`)

    const promises = Array.from({ length: CONCURRENCY }, async (_, index) => {
      const cmdStart = Date.now()

      try {
        const result = await sandbox.commands.run(`echo "result-${index}"`)
        return {
          index,
          success: result.exitCode === 0,
          stdout: result.stdout.trim(),
          durationMs: Date.now() - cmdStart,
        }
      } catch (error: any) {
        return {
          index,
          success: false,
          error: error.message,
          durationMs: Date.now() - cmdStart,
        }
      }
    })

    const results = await Promise.all(promises)
    const totalDuration = Date.now() - startTime

    const successful = results.filter(r => r.success)
    const failed = results.filter(r => !r.success)

    console.log(`\n=== Results ===`)
    console.log(`Total time: ${totalDuration}ms`)
    console.log(`Successful: ${successful.length}/${CONCURRENCY}`)

    if (failed.length > 0) {
      console.log(`Failed: ${failed.length}`)
      failed.forEach(f => console.log(`  #${f.index}: ${(f as any).error}`))
    }

    expect(failed.length).toBe(0)
    expect(successful.length).toBe(CONCURRENCY)

    for (const result of successful) {
      expect(result.stdout).toBe(`result-${result.index}`)
    }
  }, 60_000)
})
