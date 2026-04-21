/**
 * VM Stress Test
 * Tests the maximum number of VMs that can run concurrently on this machine
 *
 * Strategy:
 * - Start with a batch of VMs and progressively increase
 * - Each VM runs a light workload: git clone a repo + verify files
 * - Report success/failure rates and timing
 *
 * Workload per VM:
 * - Git clone https://github.com/github/gitignore.git (shallow, ~1MB)
 * - Verify clone by listing files and checking git log
 *
 * ===== RUN COMMANDS =====
 *
 * Run test (dev):
 *   npx vitest run tests/integration/vm-stress.test.ts
 *
 * Run test (prod):
 *   TEST_ENV=prod npx vitest run tests/integration/vm-stress.test.ts
 *
 * Custom batch size (default 5):
 *   BATCH_SIZE=10 npx vitest run tests/integration/vm-stress.test.ts
 *
 * Custom max VMs (default 50):
 *   MAX_VMS=100 npx vitest run tests/integration/vm-stress.test.ts
 *
 * Combined:
 *   BATCH_SIZE=10 MAX_VMS=100 npx vitest run tests/integration/vm-stress.test.ts
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import { getTemplateId, getGatewayConfig, getEnvironment, ensureProdApiKey } from './common'

const gatewayConfig = getGatewayConfig()
const testEnv = getEnvironment()

// Configuration from environment
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || '5', 10)
const MAX_VMS = parseInt(process.env.MAX_VMS || '50', 10)

// ANSI color codes
const COLORS = {
  RESET: '\x1b[0m',
  SUCCESS: '\x1b[32m',  // Green
  ERROR: '\x1b[31m',    // Red
  INFO: '\x1b[90m',     // Gray
  CYAN: '\x1b[36m',
  YELLOW: '\x1b[33m',
  MAGENTA: '\x1b[35m',
  BOLD: '\x1b[1m',
}

function log(message: string) {
  console.log(message)
}

function successLog(message: string) {
  console.log(`${COLORS.SUCCESS}✓${COLORS.RESET} ${message}`)
}

function errorLog(message: string) {
  console.log(`${COLORS.ERROR}✗${COLORS.RESET} ${message}`)
}

function infoLog(message: string) {
  console.log(`${COLORS.INFO}${message}${COLORS.RESET}`)
}

function headerLog(message: string) {
  console.log(`${COLORS.BOLD}${COLORS.CYAN}${message}${COLORS.RESET}`)
}

// Sleep helper
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Track VM state
interface VMResult {
  index: number
  sandboxId: string | null
  sandbox: Sandbox | null
  createTimeMs: number
  workloadTimeMs: number
  success: boolean
  error: string | null
  workloadDetails: string | null
}

// Prod database URL for API key seeding. Must be supplied via env.
const PROD_DB_URL = process.env.SUPABASE_DATABASE_URL ?? ''

async function ensureProdApiKey(): Promise<void> {
  if (testEnv !== 'prod') return

  const { execSync } = require('child_process')
  const apiKey = configs.prod.apiKey
  const crypto = require('crypto')

  const hash = crypto.createHash('sha256').update(apiKey).digest('hex')
  const prefix = apiKey.substring(0, 16)
  const mask = `${prefix}...${apiKey.slice(-4)}`

  try {
    const checkResult = execSync(
      `psql "${PROD_DB_URL}" -t -c "SELECT COUNT(*) FROM team_api_keys WHERE api_key_hash = '${hash}';"`,
      { encoding: 'utf8', timeout: 10_000 }
    ).trim()

    if (parseInt(checkResult) > 0) return

    execSync(
      `psql "${PROD_DB_URL}" -c "INSERT INTO team_api_keys (org_id, api_key_hash, api_key_prefix, api_key_mask, name) VALUES ('test-org', '${hash}', '${prefix}', '${mask}', 'SDK Integration Test Key');"`,
      { encoding: 'utf8', timeout: 10_000 }
    )
  } catch (e: any) {
    // Ignore
  }
}

describe('VM Stress Test', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('find maximum concurrent VMs', async () => {
    console.log('\n' + '='.repeat(70))
    headerLog('=== VM Stress Test - Maximum Concurrent Capacity ===')
    console.log('='.repeat(70))
    log(`Environment: ${testEnv} (${gatewayConfig.apiUrl})`)
    log(`Template: ${getTemplateId()} (4GB mem, 16GB disk)`)
    log(`Batch size: ${BATCH_SIZE}`)
    log(`Max VMs: ${MAX_VMS}`)
    log(`Workload: git clone github/gitignore (shallow) + verify`)
    console.log('='.repeat(70) + '\n')

    const allResults: VMResult[] = []
    const activeSandboxes: Sandbox[] = []
    let batchNumber = 0
    let totalCreated = 0
    let lastSuccessfulBatch = 0

    try {
      // Keep creating batches until we hit MAX_VMS or failures exceed threshold
      while (totalCreated < MAX_VMS) {
        batchNumber++
        const batchStart = totalCreated
        const batchEnd = Math.min(totalCreated + BATCH_SIZE, MAX_VMS)
        const batchCount = batchEnd - batchStart

        headerLog(`\n--- Batch ${batchNumber}: Creating VMs ${batchStart + 1} to ${batchEnd} ---`)

        // Create VMs in parallel
        const createStartTime = Date.now()
        const batchPromises: Promise<VMResult>[] = []

        for (let i = batchStart; i < batchEnd; i++) {
          const vmIndex = i + 1
          batchPromises.push(
            (async (): Promise<VMResult> => {
              const result: VMResult = {
                index: vmIndex,
                sandboxId: null,
                sandbox: null,
                createTimeMs: 0,
                workloadTimeMs: 0,
                success: false,
                error: null,
                workloadDetails: null,
              }

              try {
                const createStart = Date.now()
                const sandbox = await Sandbox.create(getTemplateId(), {
                  ...gatewayConfig,
                  timeoutMs: 300_000,  // 5 minute timeout
                })
                result.createTimeMs = Date.now() - createStart
                result.sandboxId = sandbox.sandboxId
                result.sandbox = sandbox
                activeSandboxes.push(sandbox)

                // Run a light workload: git clone a small repo and verify
                const workloadStart = Date.now()

                // Clone a small GitHub repo (gitignore templates - very small)
                let cloneResult
                try {
                  cloneResult = await sandbox.commands.run(
                    'cd /tmp && git clone --depth 1 https://github.com/github/gitignore.git test-repo 2>&1',
                    { timeoutMs: 60_000 }
                  )
                } catch (cloneErr: any) {
                  // CommandExitError has stdout, stderr, exitCode properties
                  const details = cloneErr.stderr || cloneErr.stdout || cloneErr.message || cloneErr
                  result.error = `Git clone failed: ${details}`.substring(0, 150)
                  result.workloadTimeMs = Date.now() - workloadStart
                  return result
                }

                if (cloneResult.exitCode !== 0) {
                  result.error = `Git clone failed (${cloneResult.exitCode}): ${cloneResult.stderr || cloneResult.stdout}`.substring(0, 150)
                  result.workloadTimeMs = Date.now() - workloadStart
                  return result
                }

                // Verify the clone by checking files
                let verifyResult
                try {
                  verifyResult = await sandbox.commands.run(
                    'cd /tmp/test-repo && ls -la && wc -l < Python.gitignore && git log --oneline -1',
                    { timeoutMs: 30_000 }
                  )
                } catch (verifyErr: any) {
                  result.error = `Verify exception: ${verifyErr.message || verifyErr}`
                  result.workloadTimeMs = Date.now() - workloadStart
                  return result
                }

                result.workloadTimeMs = Date.now() - workloadStart

                if (verifyResult.exitCode === 0 && verifyResult.stdout.length > 0) {
                  result.success = true
                  // Extract some details from the output
                  const lines = verifyResult.stdout.split('\n')
                  const commitLine = lines.find(l => l.match(/^[a-f0-9]+/))
                  result.workloadDetails = commitLine ? commitLine.substring(0, 40) : 'verified'
                } else {
                  result.error = `Verify failed (${verifyResult.exitCode}): ${verifyResult.stderr || verifyResult.stdout}`.substring(0, 150)
                }
              } catch (e: any) {
                const errMsg = e.message || e.toString() || JSON.stringify(e) || 'Unknown error'
                result.error = errMsg.substring(0, 150)
              }

              return result
            })()
          )
        }

        // Wait for all VMs in batch
        const batchResults = await Promise.all(batchPromises)
        const batchTime = Date.now() - createStartTime

        // Process results
        allResults.push(...batchResults)
        totalCreated = batchEnd

        const successful = batchResults.filter(r => r.success)
        const failed = batchResults.filter(r => !r.success)

        // Log batch results
        log(`\nBatch ${batchNumber} Results:`)
        log(`  Total time: ${(batchTime / 1000).toFixed(1)}s`)
        log(`  Success: ${successful.length}/${batchCount}`)

        if (successful.length > 0) {
          const avgCreate = successful.reduce((sum, r) => sum + r.createTimeMs, 0) / successful.length
          const avgWorkload = successful.reduce((sum, r) => sum + r.workloadTimeMs, 0) / successful.length
          log(`  Avg create time: ${(avgCreate / 1000).toFixed(2)}s`)
          log(`  Avg workload time: ${(avgWorkload / 1000).toFixed(2)}s (git clone + verify)`)
        }

        // Show individual results
        for (const r of batchResults) {
          if (r.success) {
            successLog(`  VM ${r.index}: ${r.sandboxId} (create: ${(r.createTimeMs / 1000).toFixed(1)}s, workload: ${(r.workloadTimeMs / 1000).toFixed(1)}s)`)
          } else {
            errorLog(`  VM ${r.index}: FAILED - ${r.error}`)
          }
        }

        // Track last successful batch
        if (successful.length === batchCount) {
          lastSuccessfulBatch = batchNumber
        }

        // Report running total
        const totalSuccess = allResults.filter(r => r.success).length
        const totalFailed = allResults.filter(r => !r.success).length
        infoLog(`\nRunning total: ${totalSuccess} success, ${totalFailed} failed, ${activeSandboxes.length} active VMs`)

        // Stop if too many failures in this batch
        if (failed.length > batchCount * 0.5) {
          errorLog(`\nStopping: More than 50% failures in batch ${batchNumber}`)
          break
        }

        // Small delay between batches
        await sleep(2000)
      }
    } finally {
      // Cleanup: kill all sandboxes
      headerLog('\n--- Cleanup: Killing all sandboxes ---')
      const killStart = Date.now()

      const killPromises = activeSandboxes.map(async (sandbox, i) => {
        try {
          await sandbox.kill()
          return true
        } catch (e) {
          return false
        }
      })

      const killResults = await Promise.all(killPromises)
      const killTime = Date.now() - killStart
      const killedCount = killResults.filter(r => r).length

      log(`Killed ${killedCount}/${activeSandboxes.length} sandboxes in ${(killTime / 1000).toFixed(1)}s`)
    }

    // Final Summary
    console.log('\n' + '='.repeat(70))
    headerLog('=== STRESS TEST RESULTS ===')
    console.log('='.repeat(70))

    const totalSuccess = allResults.filter(r => r.success).length
    const totalFailed = allResults.filter(r => !r.success).length
    const successRate = (totalSuccess / allResults.length * 100).toFixed(1)

    log(`\n${COLORS.BOLD}Summary:${COLORS.RESET}`)
    log(`  Total VMs attempted: ${allResults.length}`)
    log(`  ${COLORS.SUCCESS}Successful: ${totalSuccess}${COLORS.RESET}`)
    log(`  ${COLORS.ERROR}Failed: ${totalFailed}${COLORS.RESET}`)
    log(`  Success rate: ${successRate}%`)
    log(`  Last fully successful batch: ${lastSuccessfulBatch} (${lastSuccessfulBatch * BATCH_SIZE} VMs)`)

    if (totalSuccess > 0) {
      const successfulResults = allResults.filter(r => r.success)
      const avgCreateTime = successfulResults.reduce((sum, r) => sum + r.createTimeMs, 0) / successfulResults.length
      const avgWorkloadTime = successfulResults.reduce((sum, r) => sum + r.workloadTimeMs, 0) / successfulResults.length
      const maxCreateTime = Math.max(...successfulResults.map(r => r.createTimeMs))
      const minCreateTime = Math.min(...successfulResults.map(r => r.createTimeMs))
      const maxWorkloadTime = Math.max(...successfulResults.map(r => r.workloadTimeMs))
      const minWorkloadTime = Math.min(...successfulResults.map(r => r.workloadTimeMs))

      log(`\n${COLORS.BOLD}Timing Statistics:${COLORS.RESET}`)
      log(`  Avg VM creation time: ${(avgCreateTime / 1000).toFixed(2)}s`)
      log(`  Min VM creation time: ${(minCreateTime / 1000).toFixed(2)}s`)
      log(`  Max VM creation time: ${(maxCreateTime / 1000).toFixed(2)}s`)
      log(`  Avg workload time: ${(avgWorkloadTime / 1000).toFixed(2)}s (git clone + verify)`)
      log(`  Min workload time: ${(minWorkloadTime / 1000).toFixed(2)}s`)
      log(`  Max workload time: ${(maxWorkloadTime / 1000).toFixed(2)}s`)
    }

    // Show failure breakdown if any
    if (totalFailed > 0) {
      log(`\n${COLORS.BOLD}Failure Analysis:${COLORS.RESET}`)
      const failedResults = allResults.filter(r => !r.success)
      const errorCounts: Record<string, number> = {}
      for (const r of failedResults) {
        const errKey = r.error?.substring(0, 50) || 'Unknown'
        errorCounts[errKey] = (errorCounts[errKey] || 0) + 1
      }
      for (const [err, count] of Object.entries(errorCounts)) {
        log(`  ${count}x: ${err}`)
      }
    }

    console.log('\n' + '='.repeat(70))
    log(`${COLORS.BOLD}${COLORS.CYAN}Maximum concurrent VMs achieved: ${totalSuccess}${COLORS.RESET}`)
    console.log('='.repeat(70) + '\n')

    // Test passes if at least some VMs succeeded
    expect(totalSuccess).toBeGreaterThan(0)

  }, 1800_000)  // 30 minute timeout
})
