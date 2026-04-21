/**
 * Test: Cold boot 4GB template via hibernate + resume, multiple iterations.
 *
 * The 4GB template snapshot appears broken (CCC never responds).
 * This test bypasses the snapshot by:
 * 1. Creating a sandbox (broken, but VM exists)
 * 2. Immediately hibernating (saves rootfs only, no memfile)
 * 3. Resuming → cold boot from rootfs → should work
 * 4. Repeat hibernate/resume to measure consistency
 */
import { describe, test, expect } from 'vitest'
import { Sandbox } from '../../src'
import { getGatewayConfig } from './common'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_4GB = '28cf6050-622f-460e-8342-dac8a8b8526f'

function pad(ms: number): string {
  return `${String(Math.round(ms)).padStart(6)}ms`
}

async function checkCCC(sandboxId: string): Promise<{ ready: boolean; attempts: number }> {
  const url = `https://50051-${sandboxId}.dev.rebyte.app/supervisor.v1.SupervisorService/CheckHealth`
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/grpc-web+proto',
          'Accept': 'application/grpc-web+proto',
        },
        body: new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00]),
        signal: AbortSignal.timeout(3000),
      })
      if (res.status === 200) return { ready: true, attempts: i + 1 }
    } catch {}
    await new Promise(r => setTimeout(r, 200))
  }
  return { ready: false, attempts: 100 }
}

describe('Cold Boot 4GB', () => {
  test('hibernate/resume 3 rounds', async () => {
    const t0 = Date.now()
    const results: { round: number; hibernate: number; resume: number; ccc: number; attempts: number }[] = []

    // Step 1: Create (broken snapshot, but sandbox exists)
    console.log(`[${pad(0)}] Creating 4GB sandbox...`)
    const sandbox = await Sandbox.create(TEMPLATE_4GB, {
      ...gatewayConfig,
      timeoutMs: 60_000,
    })
    const sandboxId = sandbox.sandboxId
    console.log(`[${pad(Date.now() - t0)}] Created: ${sandboxId}`)

    try {
      for (let round = 1; round <= 3; round++) {
        console.log(`\n--- Round ${round} ---`)

        // Hibernate
        const tHib = Date.now()
        console.log(`[${pad(tHib - t0)}] Hibernating...`)
        if (round === 1) {
          await sandbox.hibernate()
        } else {
          // Need to use the connected sandbox from last resume
          await Sandbox.hibernate(sandboxId, gatewayConfig)
        }
        const hibTime = Date.now() - tHib
        console.log(`[${pad(Date.now() - t0)}] Hibernated (${hibTime}ms)`)

        // Resume (cold boot)
        const tRes = Date.now()
        console.log(`[${pad(tRes - t0)}] Resuming...`)
        await Sandbox.connect(sandboxId, {
          ...gatewayConfig,
          timeoutMs: 120_000,
        })
        const resTime = Date.now() - tRes
        console.log(`[${pad(Date.now() - t0)}] Resumed (${resTime}ms)`)

        // Check CCC
        const tCCC = Date.now()
        const ccc = await checkCCC(sandboxId)
        const cccTime = Date.now() - tCCC
        console.log(`[${pad(Date.now() - t0)}] CCC: ${ccc.ready ? 'READY' : 'FAILED'} (${cccTime}ms, ${ccc.attempts} attempts)`)

        results.push({ round, hibernate: hibTime, resume: resTime, ccc: cccTime, attempts: ccc.attempts })
        expect(ccc.ready).toBe(true)
      }

      // Summary
      console.log('\n========================================')
      console.log('  RESULTS (4GB cold boot)')
      console.log('========================================')
      console.log('  Round | Hibernate | Resume  | CCC    | Attempts')
      console.log('  ------|-----------|---------|--------|--------')
      for (const r of results) {
        console.log(`  ${r.round}     | ${String(r.hibernate).padStart(7)}ms | ${String(r.resume).padStart(5)}ms | ${String(r.ccc).padStart(4)}ms | ${r.attempts}`)
      }
      console.log('========================================\n')
    } finally {
      console.log('Cleaning up...')
      try { await Sandbox.kill(sandboxId, gatewayConfig) } catch {}
      console.log('Done.')
    }
  }, 600_000)
})
