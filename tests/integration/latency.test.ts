/**
 * Simple Latency Test
 *
 * Measures raw sandbox creation latency - should match Rust orchestrator test (~2s).
 *
 * Run:
 *   npx vitest run tests/integration/latency.test.ts 2>&1 | tee /tmp/latency.log
 *
 * Expected:
 *   - Create: ~2-3s (matches Rust latency_test)
 *   - Kill: ~300ms
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  ensureProdApiKey,
} from './common'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_ID = getTemplateId()
const templateConfig = { id: getTemplateId(), name: "default" }

describe('Latency Test', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('sandbox create/kill latency', async () => {
    console.log('\n========================================')
    console.log('  SDK Sandbox Latency Test')
    console.log(`  Template: ${templateConfig.name} (${templateConfig.memory})`)
    console.log(`  Template ID: ${TEMPLATE_ID.substring(0, 8)}...`)
    console.log('========================================\n')

    // 1. Create sandbox
    console.log('--- Creating sandbox ---')
    const createStart = Date.now()
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 30_000, // 30s timeout - should be plenty
    })
    const createTime = Date.now() - createStart
    console.log(`  Sandbox created: ${sandbox.sandboxId}`)
    console.log(`  Create time: ${createTime}ms`)

    expect(sandbox.sandboxId).toBeDefined()

    // 2. Kill sandbox
    console.log('\n--- Killing sandbox ---')
    const killStart = Date.now()
    await sandbox.kill()
    const killTime = Date.now() - killStart
    console.log(`  Kill time: ${killTime}ms`)

    // 3. Summary
    console.log('\n========================================')
    console.log('  RESULTS')
    console.log('========================================')
    console.log(`  Create: ${createTime}ms`)
    console.log(`  Kill:   ${killTime}ms`)
    console.log(`  Total:  ${createTime + killTime}ms`)
    console.log('========================================\n')

    // Assertions - create should be under 10s (generous for network)
    // Rust test shows ~2s locally, but SDK goes through gateway
    expect(createTime).toBeLessThan(10_000)
    expect(killTime).toBeLessThan(5_000)
  }, 60_000) // 60s test timeout
})
