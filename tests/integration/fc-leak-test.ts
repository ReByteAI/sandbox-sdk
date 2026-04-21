/**
 * FC Leak Stress Test
 *
 * Creates 6 VMs, then pauses all 6 at the same time.
 * This maximizes memory pressure during pause.
 *
 * Run:
 *   cd sdk/typescript-new/packages/js-sdk
 *   npx tsx tests/integration/fc-leak-test.ts
 */

import { Sandbox } from '../../src'
import { execSync } from 'child_process'

// 4GB template ID
const TEMPLATE_ID = 'b5ae1676-582a-4780-b9d4-265b6d4fa3b9'

const gatewayConfig = {
  apiUrl: 'https://dev.rebyte.app',
  apiKey: 'test-key',
  requestTimeoutMs: 300_000,  // 5 min timeout to avoid client-side timeout issues
}

function getHealthStatus(): { fcCount: number; vmCount: number; leak: boolean } {
  try {
    const output = execSync('curl -s http://localhost:8080/health', {
      encoding: 'utf8',
    })
    const health = JSON.parse(output)
    const status = health.orchestrators?.[0]?.status || {}
    return {
      fcCount: status.fc_process_count || 0,
      vmCount: status.total_vms || 0,
      leak: status.leak_detected || false,
    }
  } catch {
    return { fcCount: 0, vmCount: 0, leak: false }
  }
}

function getFcProcessCount(): number {
  try {
    const output = execSync('pgrep -c firecracker 2>/dev/null || echo 0', {
      encoding: 'utf8',
    })
    return parseInt(output.trim(), 10)
  } catch {
    return 0
  }
}

async function main() {
  console.log('='.repeat(60))
  console.log('  FC Leak Stress Test - 6 VMs, Pause All At Once')
  console.log('  Template: 4GB (24GB total)')
  console.log('='.repeat(60))
  console.log()

  const NUM_VMS = 12  // 12 x 4GB = 48GB, will definitely exhaust memory
  const sandboxes: Sandbox[] = []

  // Get initial state
  const initialStatus = getHealthStatus()
  console.log(`Initial: FC=${initialStatus.fcCount}, VMs=${initialStatus.vmCount}, leak=${initialStatus.leak}`)
  console.log()

  // Phase 1: Create 6 VMs sequentially
  console.log('--- Phase 1: Create 6 VMs ---')
  for (let i = 1; i <= NUM_VMS; i++) {
    console.log(`Creating VM ${i}/${NUM_VMS}...`)
    try {
      const sandbox = await Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 120_000,
        timeout: 600,  // 10 min lifetime
      })
      console.log(`  Created: ${sandbox.sandboxId}`)
      sandboxes.push(sandbox)

      const status = getHealthStatus()
      console.log(`  Status: FC=${status.fcCount}, VMs=${status.vmCount}`)
    } catch (error: any) {
      console.log(`  FAILED: ${error.message}`)
    }
  }

  console.log()
  console.log(`Created ${sandboxes.length}/${NUM_VMS} VMs`)
  const afterCreate = getHealthStatus()
  console.log(`After create: FC=${afterCreate.fcCount}, VMs=${afterCreate.vmCount}, leak=${afterCreate.leak}`)

  // Phase 2: Pause ALL at once
  console.log()
  console.log('--- Phase 2: Pause ALL 6 VMs simultaneously ---')
  console.log('Starting concurrent pause...')

  const pauseResults = await Promise.allSettled(
    sandboxes.map(async (sandbox, i) => {
      console.log(`[${i + 1}] Pausing ${sandbox.sandboxId}...`)
      await sandbox.pause()
      console.log(`[${i + 1}] Paused ${sandbox.sandboxId}`)
      return sandbox.sandboxId
    })
  )

  const pauseSuccess = pauseResults.filter(r => r.status === 'fulfilled').length
  const pauseFailed = pauseResults.filter(r => r.status === 'rejected').length

  console.log()
  console.log(`Pause results: ${pauseSuccess} success, ${pauseFailed} failed`)

  // Show errors
  pauseResults.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.log(`  [${i + 1}] Error: ${r.reason?.message || r.reason}`)
    }
  })

  // Phase 3: Check for leaks
  console.log()
  console.log('--- Phase 3: Check for leaks ---')
  await new Promise(resolve => setTimeout(resolve, 3000))

  const afterPause = getHealthStatus()
  console.log(`After pause: FC=${afterPause.fcCount}, VMs=${afterPause.vmCount}, leak=${afterPause.leak}`)

  // Phase 4: Cleanup
  console.log()
  console.log('--- Phase 4: Cleanup ---')
  for (const sandbox of sandboxes) {
    try {
      await sandbox.kill()
      console.log(`Killed ${sandbox.sandboxId}`)
    } catch (error: any) {
      console.log(`Kill ${sandbox.sandboxId}: ${error.message}`)
    }
  }

  await new Promise(resolve => setTimeout(resolve, 5000))

  const finalStatus = getHealthStatus()
  const finalFcCount = getFcProcessCount()

  console.log()
  console.log('='.repeat(60))
  console.log('  Results')
  console.log('='.repeat(60))
  console.log(`  VMs created: ${sandboxes.length}`)
  console.log(`  Pause success: ${pauseSuccess}`)
  console.log(`  Pause failed: ${pauseFailed}`)
  console.log(`  Final FC count: ${finalFcCount}`)
  console.log(`  Final VM count: ${finalStatus.vmCount}`)
  console.log(`  Leak detected: ${finalStatus.leak}`)

  if (finalFcCount === 0 && !finalStatus.leak) {
    console.log()
    console.log('  PASS: All FC processes cleaned up')
    process.exit(0)
  } else {
    console.log()
    console.log('  FAIL: FC leak detected')
    process.exit(1)
  }
}

main().catch(error => {
  console.error('Script failed:', error)
  process.exit(1)
})
