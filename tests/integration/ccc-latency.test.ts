/**
 * CCC gRPC Readiness Latency Test
 *
 * Measures how long it takes for CCC (Coding Agent Controller) to respond
 * to a gRPC health check after a VM is created.
 *
 * The VM template has CCC baked in via systemd — CCC should already be running
 * when the snapshot resumes. This test measures the actual latency.
 *
 * Run:
 *   TEST_TEMPLATE=large npx vitest run tests/integration/ccc-latency.test.ts 2>&1 | tee /tmp/ccc-latency.log
 */

import { describe, test, expect, beforeAll } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  getEnvironment,
  ensureProdApiKey,
} from './common'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_ID = getTemplateId()
const templateConfig = { id: getTemplateId(), name: "default" }
const CCC_PORT = 50051
const POLL_MS = 100 // poll every 100ms for fine-grained measurement

function getDomain(): string {
  return getEnvironment() === 'prod' ? 'prod.rebyte.app' : 'dev.rebyte.app'
}

/**
 * Check if CCC gRPC-web server is responding.
 * Uses gRPC-web protocol — any HTTP 200 response (even with grpc error) means CCC is up.
 * A connection refused / timeout means CCC is not ready yet.
 */
async function checkCCCReady(sandboxId: string): Promise<{ ready: boolean; version?: string; detail?: string }> {
  const url = `https://${CCC_PORT}-${sandboxId}.${getDomain()}/supervisor.v1.SupervisorService/CheckHealth`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/grpc-web+proto',
        'Accept': 'application/grpc-web+proto',
      },
      // Empty protobuf message for CheckHealthRequest (no fields = zero bytes payload)
      // gRPC-web frame: 0x00 (not compressed) + 4-byte big-endian length (0) = 5 bytes
      body: new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]),
      signal: AbortSignal.timeout(3000),
    })

    // Any HTTP response from the gRPC server means CCC is up
    // grpc-status 0 = OK, anything else = server error but still responding
    const grpcStatus = res.headers.get('grpc-status')
    return {
      ready: true,
      detail: `HTTP ${res.status}, grpc-status=${grpcStatus}`,
    }
  } catch (error: any) {
    return {
      ready: false,
      detail: error.message || String(error),
    }
  }
}

describe('CCC Latency Test', () => {
  beforeAll(async () => {
    await ensureProdApiKey()
  }, 30_000)

  test('CCC readiness after fresh VM create', async () => {
    console.log('\n========================================')
    console.log('  CCC gRPC Readiness Latency Test')
    console.log(`  Template: ${templateConfig.name} (${templateConfig.memory})`)
    console.log(`  Template ID: ${TEMPLATE_ID.substring(0, 8)}...`)
    console.log(`  Poll interval: ${POLL_MS}ms`)
    console.log('========================================\n')

    // Step 1: Create VM
    const t0 = Date.now()
    console.log(`[${pad(0)}] Creating sandbox...`)

    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    })
    const sandboxId = sandbox.sandboxId

    const tCreated = Date.now()
    console.log(`[${pad(tCreated - t0)}] Sandbox created: ${sandboxId} (${tCreated - t0}ms)`)

    try {
      // Step 2: Immediately poll CCC health check
      console.log(`[${pad(Date.now() - t0)}] Polling CCC health check...`)

      let attempts = 0
      let firstError = ''
      let cccReady = false

      while (Date.now() - t0 < 60_000) {
        attempts++
        const result = await checkCCCReady(sandboxId)

        if (result.ready) {
          const tReady = Date.now()
          cccReady = true

          console.log(`[${pad(tReady - t0)}] CCC READY! (${result.detail})`)
          console.log('')
          console.log('========================================')
          console.log('  RESULTS')
          console.log('========================================')
          console.log(`  VM create:            ${tCreated - t0}ms`)
          console.log(`  CCC ready:            ${tReady - t0}ms`)
          console.log(`  CCC after create:     ${tReady - tCreated}ms`)
          console.log(`  Health check attempts: ${attempts}`)
          console.log('========================================\n')

          // CCC should be ready almost instantly since it's baked into the snapshot
          // Allow generous margin for network + GCP load balancer routing
          expect(tReady - tCreated).toBeLessThan(15_000)
          break
        }

        if (!firstError) {
          firstError = result.detail || 'unknown'
          console.log(`[${pad(Date.now() - t0)}] First error: ${firstError}`)
        }

        if (attempts % 20 === 0) {
          console.log(`[${pad(Date.now() - t0)}] Attempt ${attempts}: ${result.detail}`)
        }

        await new Promise(r => setTimeout(r, POLL_MS))
      }

      expect(cccReady).toBe(true)
    } finally {
      // Always cleanup
      console.log('Cleaning up...')
      await sandbox.kill()
      console.log('Done.')
    }
  }, 120_000)

  test('CCC readiness after pause/resume', async () => {
    console.log('\n========================================')
    console.log('  CCC Readiness After Pause/Resume')
    console.log(`  Template: ${templateConfig.name} (${templateConfig.memory})`)
    console.log('========================================\n')

    const t0 = Date.now()

    // Step 1: Create and verify CCC is ready
    console.log(`[${pad(0)}] Creating sandbox...`)
    const sandbox = await Sandbox.create(TEMPLATE_ID, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`[${pad(Date.now() - t0)}] Created: ${sandboxId}`)

    // Wait for CCC to be ready initially (up to 30s)
    let ready = false
    for (let i = 0; i < 300; i++) {
      const result = await checkCCCReady(sandboxId)
      if (result.ready) { ready = true; break }
      await new Promise(r => setTimeout(r, POLL_MS))
    }
    expect(ready).toBe(true)
    console.log(`[${pad(Date.now() - t0)}] CCC initially ready`)

    try {
      // Step 2: Hibernate (rootfs-only, no memfile upload)
      console.log(`[${pad(Date.now() - t0)}] Hibernating (rootfs-only)...`)
      const tPauseStart = Date.now()
      await sandbox.hibernate()
      const tPaused = Date.now()
      console.log(`[${pad(tPaused - t0)}] Hibernated (${tPaused - tPauseStart}ms)`)

      // Step 3: Resume (connect to hibernated sandbox triggers cold boot)
      console.log(`[${pad(Date.now() - t0)}] Resuming...`)
      const tResumeStart = Date.now()
      const resumed = await Sandbox.connect(sandboxId, {
        ...gatewayConfig,
        timeoutMs: 60_000,
      })
      const tResumed = Date.now()
      console.log(`[${pad(tResumed - t0)}] Resumed (${tResumed - tResumeStart}ms)`)

      // Step 4: Poll CCC
      console.log(`[${pad(Date.now() - t0)}] Polling CCC after resume...`)
      let attempts = 0
      let cccReady = false
      let firstError = ''

      while (Date.now() - tResumed < 30_000) {
        attempts++
        const result = await checkCCCReady(sandboxId)

        if (result.ready) {
          const tReady = Date.now()
          cccReady = true

          console.log(`[${pad(tReady - t0)}] CCC READY after resume!`)
          console.log('')
          console.log('========================================')
          console.log('  HIBERNATE/RESUME RESULTS')
          console.log('========================================')
          console.log(`  Hibernate time:       ${tPaused - tPauseStart}ms`)
          console.log(`  Resume time:          ${tResumed - tResumeStart}ms`)
          console.log(`  CCC after resume:     ${tReady - tResumed}ms`)
          console.log(`  Health check attempts: ${attempts}`)
          console.log('========================================\n')

          expect(tReady - tResumed).toBeLessThan(15_000)
          break
        }

        if (!firstError) {
          firstError = result.detail || 'unknown'
          console.log(`[${pad(Date.now() - t0)}] First error: ${firstError}`)
        }

        if (attempts % 20 === 0) {
          console.log(`[${pad(Date.now() - t0)}] Attempt ${attempts}: ${result.detail}`)
        }

        await new Promise(r => setTimeout(r, POLL_MS))
      }

      expect(cccReady).toBe(true)
    } finally {
      console.log('Cleaning up...')
      try { await Sandbox.kill(sandboxId, gatewayConfig) } catch {}
      console.log('Done.')
    }
  }, 180_000)
})

function pad(ms: number): string {
  return `${String(Math.round(ms)).padStart(6)}ms`
}
