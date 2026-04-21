/**
 * NFS Pre-warm Test — Step 1: Create, work, pause
 *
 * This is the first half of a two-step test that proves NFS pre-warming works
 * across server restarts (eliminating all in-memory cache effects).
 *
 * ## Flow
 * 1. Create sandbox, do work, pause it
 * 2. Wait for GCS upload + NFS pre-warm to complete
 * 3. Verify NFS chunks exist on disk
 * 4. Print sandbox ID for Step 2
 *
 * ## Usage
 * ```bash
 * # Step 1: Pause (this script)
 * TEST_TEMPLATE=large npx vitest run tests/integration/nfs-prewarm-step1-pause.test.ts
 *
 * # Then restart server:
 * ./build-and-restart-server.sh
 *
 * # Step 2: Resume (separate script)
 * SANDBOX_ID=<id from step 1> npx vitest run tests/integration/nfs-prewarm-step2-resume.test.ts
 * ```
 */

import { describe, test, expect } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  getEnvironment,
  getNamespace,
} from './common'
import { execSync } from 'child_process'
import { writeFileSync } from 'fs'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_ID = getTemplateId()

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now()
  const result = await fn()
  return [result, Date.now() - start]
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/** Count NFS chunk files for a sandbox build */
function countNfsChunks(sandboxId: string, buildId: string, fileType: string): number {
  const namespace = getNamespace()
  const nfsDir = `/mnt/nfs-cache/cache/sandboxes/${namespace}/${sandboxId}/paused/${buildId}/${fileType}`
  try {
    const output = execSync(
      `sudo ls "${nfsDir}" 2>/dev/null | grep -c '.bin$'`,
      { encoding: 'utf8', timeout: 10_000 }
    ).trim()
    return parseInt(output) || 0
  } catch {
    return 0
  }
}

/** Get the latest build ID from GCS for a sandbox */
function getLatestBuildId(sandboxId: string): string | null {
  const namespace = getNamespace()
  const gcsPath = `gs://microsandbox/sandboxes/${namespace}/${sandboxId}/paused/`
  try {
    const output = execSync(`gsutil ls ${gcsPath}`, { encoding: 'utf8', timeout: 15_000 })
    const dirs = output.trim().split('\n')
      .filter(l => l.endsWith('/'))
      .map(l => l.replace(gcsPath, '').replace(/\/$/, ''))
      .filter(s => s)
    return dirs.length > 0 ? dirs[dirs.length - 1] : null
  } catch {
    return null
  }
}

describe('NFS Pre-warm Step 1: Pause', () => {
  test('create sandbox, do work, pause, verify NFS pre-warm', async () => {
    const template = { id: getTemplateId(), name: "default" }
    const env = getEnvironment()

    console.log(`\n${'='.repeat(60)}`)
    console.log(`  NFS Pre-warm Test — Step 1: Pause`)
    console.log(`  Template: ${template.name} (${template.memory})`)
    console.log(`  Environment: ${env} (${gatewayConfig.apiUrl})`)
    console.log(`${'='.repeat(60)}\n`)

    // ================================================================
    // Phase 1: Create sandbox
    // ================================================================
    console.log('--- Phase 1: Create sandbox ---')
    const [sandbox, createMs] = await timed(() =>
      Sandbox.create(TEMPLATE_ID, {
        ...gatewayConfig,
        timeoutMs: 300_000,
      })
    )
    const sandboxId = sandbox.sandboxId
    console.log(`  Created: ${sandboxId} (${secs(createMs)}s)`)

    try {
      // ================================================================
      // Phase 2: Do work
      // ================================================================
      console.log('\n--- Phase 2: Do work in sandbox ---')

      const [, writeMs] = await timed(async () => {
        await sandbox.commands.run(
          'dd if=/dev/urandom of=/home/user/bench.bin bs=1M count=10 2>/dev/null',
          { timeoutMs: 30_000 }
        )
      })
      console.log(`  Wrote 10MB random data (${secs(writeMs)}s)`)

      const marker = `PREWARM_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
      await sandbox.files.write('/home/user/marker.txt', marker)
      console.log(`  Marker: ${marker}`)

      await sandbox.commands.run('sync', { timeoutMs: 10_000 })

      // ================================================================
      // Phase 3: Pause
      // ================================================================
      console.log('\n--- Phase 3: Pause ---')
      const [, pauseMs] = await timed(() => sandbox.pause())
      console.log(`  Paused (${secs(pauseMs)}s)`)

      const info = await sandbox.getInfo()
      expect(info.state).toBe('paused')

      // ================================================================
      // Phase 4: Wait for GCS upload + NFS pre-warm
      // ================================================================
      console.log('\n--- Phase 4: Wait for GCS upload + NFS pre-warm ---')

      // Wait for GCS upload to complete (check for memfile + snapfile)
      let gcsReady = false
      for (let i = 0; i < 30; i++) {
        try {
          const buildId = getLatestBuildId(sandboxId)
          if (buildId) {
            const namespace = getNamespace()
            const gcsBase = `gs://microsandbox/sandboxes/${namespace}/${sandboxId}/paused/${buildId}/`
            const files = execSync(`gsutil ls ${gcsBase}`, { encoding: 'utf8', timeout: 10_000 })
            if (files.includes('memfile') && files.includes('snapfile')) {
              console.log(`  GCS upload complete (build_id: ${buildId})`)
              gcsReady = true
              break
            }
          }
        } catch { /* retry */ }
        console.log(`  Waiting for GCS upload... (${(i + 1) * 2}s)`)
        await new Promise(r => setTimeout(r, 2000))
      }
      expect(gcsReady).toBe(true)

      // Now wait for NFS pre-warm to complete
      // The pre-warm runs after GCS upload, so we poll for NFS chunk files
      const buildId = getLatestBuildId(sandboxId)!
      console.log(`\n  Waiting for NFS pre-warm to complete...`)
      console.log(`  (Checking for chunk files at /mnt/nfs-cache/cache/sandboxes/${getNamespace()}/${sandboxId}/paused/${buildId}/memfile/)`)

      let memfileChunks = 0
      let rootfsChunks = 0
      let stableCount = 0
      let lastCount = 0

      // Poll until chunk count stabilizes (same count for 10s = pre-warm done)
      for (let i = 0; i < 120; i++) {
        memfileChunks = countNfsChunks(sandboxId, buildId, 'memfile')
        rootfsChunks = countNfsChunks(sandboxId, buildId, 'rootfs')
        const total = memfileChunks + rootfsChunks

        if (total === lastCount && total > 0) {
          stableCount++
        } else {
          stableCount = 0
        }
        lastCount = total

        if (i % 5 === 0) {
          console.log(`  [${i * 2}s] memfile: ${memfileChunks} chunks, rootfs: ${rootfsChunks} chunks (stable: ${stableCount})`)
        }

        // Stable for 10s (5 checks * 2s) = pre-warm is done
        if (stableCount >= 5) {
          console.log(`  NFS pre-warm complete! (stable for 10s)`)
          break
        }

        await new Promise(r => setTimeout(r, 2000))
      }

      // ================================================================
      // Phase 5: Verify NFS chunks
      // ================================================================
      console.log('\n--- Phase 5: Verify NFS chunks ---')
      console.log(`  Memfile chunks on NFS: ${memfileChunks}`)
      console.log(`  Rootfs chunks on NFS:  ${rootfsChunks}`)
      expect(memfileChunks).toBeGreaterThan(0)

      // ================================================================
      // Summary
      // ================================================================
      console.log(`\n${'='.repeat(60)}`)
      console.log(`  STEP 1 COMPLETE`)
      console.log(`${'='.repeat(60)}`)
      console.log()
      console.log(`  Sandbox ID: ${sandboxId}`)
      console.log(`  Build ID:   ${buildId}`)
      console.log(`  Marker:     ${marker}`)
      console.log(`  NFS chunks: ${memfileChunks} memfile + ${rootfsChunks} rootfs`)
      console.log()
      console.log(`  NEXT STEPS:`)
      console.log(`  1. Restart server:  ./build-and-restart-server.sh`)
      console.log(`  2. Run step 2:`)
      console.log(`     SANDBOX_ID=${sandboxId} MARKER="${marker}" npx vitest run tests/integration/nfs-prewarm-step2-resume.test.ts`)
      console.log()
      console.log(`${'='.repeat(60)}\n`)

      // Write sandbox info to a temp file for easy piping to step 2
      const stateFile = '/tmp/nfs-prewarm-test-state.json'
      writeFileSync(stateFile, JSON.stringify({
        sandboxId,
        buildId,
        marker,
        memfileChunks,
        rootfsChunks,
        template: template.name,
        timestamp: new Date().toISOString(),
      }, null, 2))
      console.log(`  State saved to ${stateFile}`)

    } catch (error) {
      // Don't kill the sandbox on failure — we need it for step 2
      console.error(`\n  ERROR: ${error}`)
      throw error
    }
  }, 600_000)
})
