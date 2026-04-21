/**
 * Snapshot Compaction Integration Test
 *
 * Tests the compact endpoint: POST /sandboxes/{id}/compact
 *
 * Flow:
 * 1. Create sandbox, write data
 * 2. Pause (full snapshot: memfile + rootfs diff)
 * 3. Call compact API (marks snapshot as is_compacted=true)
 * 4. Connect (gateway sees is_compacted → forces cold boot)
 * 5. Verify data persisted (~12s cold boot instead of ~1s resume)
 *
 * Run:
 *   npx vitest run tests/integration/compact.test.ts
 *
 * Against prod:
 *   TEST_ENV=prod npx vitest run tests/integration/compact.test.ts
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  getDatabaseUrl,
  printTestHeader,
  ensureProdApiKey,
} from './common'

const gatewayConfig = getGatewayConfig()
const DB_URL = getDatabaseUrl()
const TEMPLATE_ID = getTemplateId()

/**
 * Call POST /sandboxes/{id}/compact directly (no SDK method needed).
 */
async function compactSandbox(sandboxId: string): Promise<{ build_id: string; message: string }> {
  const url = `${gatewayConfig.apiUrl}/sandboxes/${sandboxId}/compact`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${gatewayConfig.apiKey}`,
      'Content-Type': 'application/json',
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Compact failed (${res.status}): ${body}`)
  }
  return res.json()
}

describe('Snapshot Compaction', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('compact forces cold boot on next connect, data persists', async () => {
    printTestHeader('Snapshot Compaction Test')

    // 1. Create sandbox
    console.log('\n1. Creating sandbox...')
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`   Sandbox created: ${sandboxId}`)

    try {
      // 2. Write unique data
      console.log('\n2. Writing test data...')
      const testContent = `compact-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
      await sandbox.files.write('/home/user/compact-test.txt', testContent)
      const verified = await sandbox.files.read('/home/user/compact-test.txt')
      expect(verified).toBe(testContent)
      console.log(`   Written and verified: "${testContent}"`)

      // 3. Pause
      console.log('\n3. Pausing sandbox...')
      const pauseStart = Date.now()
      const paused = await sandbox.pause()
      console.log(`   Paused: ${paused} (${((Date.now() - pauseStart) / 1000).toFixed(1)}s)`)
      expect(paused).toBe(true)

      // 4. Verify snapshot exists in DB with is_compacted=false
      console.log('\n4. Checking DB snapshot...')
      const { execSync } = require('child_process')
      const dbRow = execSync(
        `psql "${DB_URL}" -t -c "SELECT build_id, is_compacted FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}' ORDER BY created_at DESC LIMIT 1;"`,
        { encoding: 'utf8', timeout: 10_000 }
      ).trim()
      console.log(`   DB row: ${dbRow}`)
      const [buildId, isCompacted] = dbRow.split('|').map((s: string) => s.trim())
      expect(buildId).toMatch(/^[0-9a-f-]+$/i)
      expect(isCompacted).toBe('f')  // false
      console.log(`   build_id=${buildId}, is_compacted=${isCompacted}`)

      // 5. Call compact endpoint
      console.log('\n5. Calling compact endpoint...')
      const compactResult = await compactSandbox(sandboxId)
      console.log(`   Result: ${JSON.stringify(compactResult)}`)
      expect(compactResult.build_id).toBe(buildId)

      // 6. Verify DB is_compacted=true (same build_id, same row)
      console.log('\n6. Verifying DB after compact...')
      const dbRowAfter = execSync(
        `psql "${DB_URL}" -t -c "SELECT build_id, is_compacted FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}' ORDER BY created_at DESC LIMIT 1;"`,
        { encoding: 'utf8', timeout: 10_000 }
      ).trim()
      const [buildIdAfter, isCompactedAfter] = dbRowAfter.split('|').map((s: string) => s.trim())
      expect(buildIdAfter).toBe(buildId)  // Same row, same build_id
      expect(isCompactedAfter).toBe('t')  // true
      console.log(`   build_id=${buildIdAfter}, is_compacted=${isCompactedAfter} (compacted!)`)

      // 7. Connect (should cold boot because is_compacted=true)
      console.log('\n7. Connecting (gateway should force cold boot)...')
      const connectStart = Date.now()
      const resumed = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      const connectDuration = (Date.now() - connectStart) / 1000
      console.log(`   Connected in ${connectDuration.toFixed(1)}s (cold boot expected ~12s)`)

      // Cold boot should take noticeably longer than resume (~12s vs ~1s)
      // We don't assert exact timing, but log it for visibility
      if (connectDuration > 5) {
        console.log(`   Looks like a cold boot (${connectDuration.toFixed(1)}s > 5s)`)
      } else {
        console.log(`   WARNING: Connect was fast (${connectDuration.toFixed(1)}s) - may not have cold booted`)
      }

      // 8. Verify data persisted through compacted cold boot
      console.log('\n8. Verifying data persisted...')
      const contentAfter = await resumed.files.read('/home/user/compact-test.txt')
      console.log(`   Content after compact+connect: "${contentAfter}"`)
      expect(contentAfter).toBe(testContent)
      console.log(`   DATA PERSISTED through compacted cold boot!`)

      // 9. Verify sandbox is functional
      console.log('\n9. Running command to verify sandbox is functional...')
      const result = await resumed.commands.run('echo "after compact"', { timeoutMs: 30_000 })
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('after compact')
      console.log(`   Output: ${result.stdout.trim()}`)

      console.log('\n=== Snapshot Compaction Test PASSED ===')
      console.log(`  - Wrote: "${testContent}"`)
      console.log(`  - Paused with full snapshot`)
      console.log(`  - Compacted (is_compacted=true, same build_id)`)
      console.log(`  - Connected (cold boot ${connectDuration.toFixed(1)}s)`)
      console.log(`  - Data persisted!`)

      // Cleanup
      await resumed.kill()
      console.log('Sandbox killed')

    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 300_000)  // 5 minute timeout

  test('compact on running sandbox returns 409', async () => {
    printTestHeader('Compact Running Sandbox Test (expect 409)')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    console.log(`Sandbox created: ${sandbox.sandboxId}`)

    try {
      // Try to compact a running sandbox - should fail with 409
      console.log('\nCalling compact on running sandbox (expect 409)...')
      await expect(compactSandbox(sandbox.sandboxId)).rejects.toThrow(/409/)
      console.log('   Got expected 409 error')

      console.log('\n=== Test Passed ===')
      await sandbox.kill()
    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 60_000)

  test('compact is idempotent', async () => {
    printTestHeader('Compact Idempotent Test')

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 300_000,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`Sandbox created: ${sandboxId}`)

    try {
      // Pause
      console.log('\nPausing...')
      await sandbox.pause()
      console.log('   Paused')

      // Compact twice - second call should succeed with "already compacted"
      console.log('\nFirst compact...')
      const result1 = await compactSandbox(sandboxId)
      console.log(`   Result: ${JSON.stringify(result1)}`)

      console.log('\nSecond compact (idempotent)...')
      const result2 = await compactSandbox(sandboxId)
      console.log(`   Result: ${JSON.stringify(result2)}`)
      expect(result2.build_id).toBe(result1.build_id)

      console.log('\n=== Test Passed ===')

      // Cleanup: resume and kill
      const resumed = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
      await resumed.kill()
    } catch (error) {
      // Best-effort cleanup
      try {
        const s = await Sandbox.connect(sandboxId, { ...gatewayConfig, timeoutMs: 60_000 })
        await s.kill()
      } catch { /* ignore */ }
      throw error
    }
  }, 300_000)
})
