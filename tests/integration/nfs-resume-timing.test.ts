/**
 * Pure NFS Resume Timing Test
 *
 * Two-phase test to measure resume latency from NFS chunk cache
 * with ZERO in-memory state (server restarted between phases).
 *
 * ## Phase 1: Setup (populates NFS cache)
 *   npx vitest run tests/integration/nfs-resume-timing.test.ts -t "phase1"
 *
 * ## Manual: Restart server + delete local SSD
 *   sudo pkill -9 msborchestrator
 *   sudo rm -rf /mnt/storage/builds/*
 *   # Then restart orchestrator (wait for it to be ready)
 *   # The build-and-restart-server.sh will rebuild - if you just want restart:
 *   # just restart the process manually
 *
 * ## Phase 2: Measure pure NFS resume
 *   SANDBOX_ID=<id-from-phase1> npx vitest run tests/integration/nfs-resume-timing.test.ts -t "phase2"
 */

import { describe, test, expect } from 'vitest'
import { Sandbox } from '../../src'
import {
  getTemplateId,
  getGatewayConfig,
  getEnvironment,
  getDatabaseUrl,
  getNamespace,
} from './common'
import { execSync } from 'child_process'

const gatewayConfig = getGatewayConfig()
const TEMPLATE_ID = getTemplateId()
const DB_URL = getDatabaseUrl()

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now()
  const result = await fn()
  return [result, Date.now() - start]
}

function secs(ms: number): string {
  return (ms / 1000).toFixed(1)
}

/** Delete all local SSD build dirs for a sandbox */
function deleteLocalBuilds(sandboxId: string): number {
  const buildsDir = '/mnt/storage/builds'
  const namespace = getNamespace()
  const gcsPath = `gs://microsandbox/sandboxes/${namespace}/${sandboxId}/paused/`
  let deleted = 0

  try {
    const output = execSync(`gsutil ls ${gcsPath}`, { encoding: 'utf8', timeout: 15_000 })
    const buildIds = output.trim().split('\n')
      .filter(l => l.endsWith('/'))
      .map(l => l.replace(gcsPath, '').replace(/\/$/, ''))
      .filter(s => s)

    for (const buildId of buildIds) {
      try {
        const matches = execSync(
          `sudo ls "${buildsDir}" | grep "^${buildId}"`,
          { encoding: 'utf8', timeout: 5_000 }
        ).trim().split('\n').filter(s => s)
        for (const entry of matches) {
          execSync(`sudo rm -rf "${buildsDir}/${entry}"`)
          deleted++
        }
      } catch { /* no matches */ }
    }
  } catch { /* no GCS data */ }

  // Also delete template build dirs
  try {
    const matches = execSync(
      `sudo ls "${buildsDir}" | grep "^${TEMPLATE_ID}"`,
      { encoding: 'utf8', timeout: 5_000 }
    ).trim().split('\n').filter(s => s)
    for (const entry of matches) {
      execSync(`sudo rm -rf "${buildsDir}/${entry}"`)
      deleted++
    }
  } catch { /* no matches */ }

  return deleted
}

/** Delete NFS chunk cache for sandbox snapshots */
function deleteNfsChunkCache(sandboxId: string): number {
  const namespace = getNamespace()
  const nfsCacheBase = `/mnt/nfs-cache/cache/sandboxes/${namespace}/${sandboxId}/paused`
  let deleted = 0
  try {
    const entries = execSync(
      `sudo ls "${nfsCacheBase}" 2>/dev/null`,
      { encoding: 'utf8', timeout: 5_000 }
    ).trim().split('\n').filter(s => s)
    for (const entry of entries) {
      execSync(`sudo rm -rf "${nfsCacheBase}/${entry}"`)
      deleted++
    }
  } catch { /* doesn't exist */ }
  return deleted
}

/** Delete NFS template chunk cache (memfile/, rootfs/, *.cache) */
function deleteNfsTemplateCache(templateId: string): number {
  const nfsCacheBase = `/mnt/nfs-cache/cache/${templateId}`
  let deleted = 0
  for (const entry of ['memfile', 'rootfs', 'memfile.cache', 'rootfs.cache']) {
    try {
      execSync(`sudo rm -rf "${nfsCacheBase}/${entry}" 2>/dev/null`, { encoding: 'utf8', timeout: 10_000 })
      deleted++
    } catch { /* doesn't exist */ }
  }
  return deleted
}

/** Drop Linux page cache (force NFS reads to go to disk/network) */
function dropPageCache(): void {
  try {
    execSync('sudo sh -c "sync; echo 3 > /proc/sys/vm/drop_caches"', { timeout: 5_000 })
  } catch { /* best effort */ }
}

describe('NFS Resume Timing', () => {

  test('phase1: setup NFS cache', async () => {
    const template = { id: getTemplateId(), name: "default" }
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  Phase 1: Setup NFS Cache`)
    console.log(`  Template: ${template.name} (${template.memory})`)
    console.log(`${'='.repeat(60)}\n`)

    // Create sandbox
    console.log('--- Creating sandbox ---')
    const [sandbox, createMs] = await timed(() =>
      Sandbox.create(TEMPLATE_ID, { ...gatewayConfig, timeoutMs: 300_000 })
    )
    console.log(`  Created: ${sandbox.sandboxId} (${secs(createMs)}s)`)

    try {
      // Do work
      console.log('\n--- Doing work ---')
      await sandbox.commands.run(
        'dd if=/dev/urandom of=/home/user/bench.bin bs=1M count=10 2>/dev/null',
        { timeoutMs: 30_000 }
      )
      const marker = `NFS_TEST_${Date.now()}`
      await sandbox.files.write('/home/user/marker.txt', marker)
      await sandbox.commands.run('sync', { timeoutMs: 10_000 })
      console.log(`  Marker: ${marker}`)

      // Pause
      console.log('\n--- Pausing ---')
      const [, pauseMs] = await timed(() => sandbox.pause())
      console.log(`  Paused (${secs(pauseMs)}s)`)

      // Wait for GCS upload
      const namespace = getNamespace()
      const gcsPath = `gs://microsandbox/sandboxes/${namespace}/${sandbox.sandboxId}/paused/`
      console.log('\n--- Waiting for GCS upload ---')
      let gcsVerified = false
      for (let i = 0; i < 30; i++) {
        try {
          const output = execSync(`gsutil ls ${gcsPath}`, { encoding: 'utf8', timeout: 10_000 })
          const dirs = output.trim().split('\n').filter(l => l.endsWith('/'))
          if (dirs.length > 0) {
            const latest = dirs[dirs.length - 1]
            const files = execSync(`gsutil ls ${latest}`, { encoding: 'utf8', timeout: 10_000 })
            if (files.includes('memfile') && files.includes('snapfile')) {
              console.log(`  GCS upload verified: ${dirs.length} snapshot(s)`)
              gcsVerified = true
              break
            }
          }
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 2000))
      }
      expect(gcsVerified).toBe(true)

      // Delete ALL caches (force pure GCS cold resume)
      console.log('\n--- Deleting ALL caches ---')
      const d1 = deleteLocalBuilds(sandbox.sandboxId)
      console.log(`  Local SSD: deleted ${d1} dir(s)`)
      const d2 = deleteNfsChunkCache(sandbox.sandboxId)
      console.log(`  NFS sandbox chunks: deleted ${d2} dir(s)`)
      const d3 = deleteNfsTemplateCache(TEMPLATE_ID)
      console.log(`  NFS template chunks: deleted ${d3} dir(s)`)

      // Cold resume (this populates NFS chunk cache)
      console.log('\n--- Cold resume (populates NFS) ---')
      const [coldSandbox, coldMs] = await timed(() =>
        Sandbox.connect(sandbox.sandboxId, { ...gatewayConfig, timeoutMs: 300_000 })
      )
      console.log(`  Resumed (${secs(coldMs)}s)`)

      // Verify
      const result = await coldSandbox.commands.run('cat /home/user/marker.txt', { timeoutMs: 30_000 })
      expect(result.stdout.trim()).toBe(marker)
      console.log('  Marker verified')

      // Pause again (NFS is now populated)
      console.log('\n--- Pausing again ---')
      const [, pause2Ms] = await timed(() => coldSandbox.pause())
      console.log(`  Paused (${secs(pause2Ms)}s)`)

      // Clean up DB at the end
      // (We don't kill the sandbox - we need it for phase 2)

      console.log(`\n${'='.repeat(60)}`)
      console.log(`  Phase 1 DONE`)
      console.log(`  Sandbox ID: ${sandbox.sandboxId}`)
      console.log(`  Marker: ${marker}`)
      console.log(``)
      console.log(`  Next steps:`)
      console.log(`    1. Restart the server:`)
      console.log(`       sudo pkill -TERM msborchestrator; sleep 2; sudo pkill -9 msborchestrator`)
      console.log(`       # Then start it again (see build-and-restart-server.sh)`)
      console.log(`    2. Delete local SSD:`)
      console.log(`       sudo rm -rf /mnt/storage/builds/*`)
      console.log(`    3. Drop page cache:`)
      console.log(`       sudo sh -c "sync; echo 3 > /proc/sys/vm/drop_caches"`)
      console.log(`    4. Run phase 2:`)
      console.log(`       SANDBOX_ID=${sandbox.sandboxId} MARKER="${marker}" npx vitest run tests/integration/nfs-resume-timing.test.ts -t "phase2"`)
      console.log(`${'='.repeat(60)}\n`)

    } catch (error) {
      await Promise.allSettled([sandbox.kill()])
      throw error
    }
  }, 600_000)

  test('phase2: measure pure NFS resume', async () => {
    const sandboxId = process.env.SANDBOX_ID
    const expectedMarker = process.env.MARKER
    if (!sandboxId) {
      console.log('SANDBOX_ID not set. Run phase1 first.')
      return
    }

    const template = { id: getTemplateId(), name: "default" }
    console.log(`\n${'='.repeat(60)}`)
    console.log(`  Phase 2: Pure NFS Resume Timing`)
    console.log(`  Template: ${template.name} (${template.memory})`)
    console.log(`  Sandbox: ${sandboxId}`)
    console.log(`${'='.repeat(60)}\n`)

    // Verify local SSD is clean
    console.log('--- Verifying local SSD is clean ---')
    try {
      const lsOutput = execSync('sudo ls /mnt/storage/builds/ 2>/dev/null', { encoding: 'utf8', timeout: 5_000 }).trim()
      if (lsOutput) {
        console.log(`  WARNING: Local SSD still has entries: ${lsOutput.split('\n').length}`)
        console.log('  Deleting them now...')
        deleteLocalBuilds(sandboxId)
        // Also delete template dirs
        try {
          execSync(`sudo rm -rf /mnt/storage/builds/${TEMPLATE_ID}*`, { timeout: 5_000 })
        } catch {}
      } else {
        console.log('  Local SSD is clean')
      }
    } catch {
      console.log('  Local SSD is clean (empty)')
    }

    // Drop page cache to force real NFS reads
    console.log('\n--- Dropping page cache ---')
    dropPageCache()
    console.log('  Page cache dropped')

    // Verify NFS chunks exist
    console.log('\n--- Checking NFS chunk cache ---')
    const namespace = getNamespace()
    const nfsSandboxPath = `/mnt/nfs-cache/cache/sandboxes/${namespace}/${sandboxId}/paused`
    const nfsTemplatePath = `/mnt/nfs-cache/cache/${TEMPLATE_ID}`
    try {
      const sandboxChunks = execSync(`sudo find ${nfsSandboxPath} -name "*.bin" 2>/dev/null | wc -l`, { encoding: 'utf8', timeout: 10_000 }).trim()
      console.log(`  Sandbox NFS chunks: ${sandboxChunks} files`)
    } catch { console.log('  Sandbox NFS chunks: not found') }
    try {
      const templateMemChunks = execSync(`sudo find ${nfsTemplatePath}/memfile -name "*.bin" 2>/dev/null | wc -l`, { encoding: 'utf8', timeout: 10_000 }).trim()
      const templateRootChunks = execSync(`sudo find ${nfsTemplatePath}/rootfs -name "*.bin" 2>/dev/null | wc -l`, { encoding: 'utf8', timeout: 10_000 }).trim()
      console.log(`  Template NFS memfile chunks: ${templateMemChunks} files`)
      console.log(`  Template NFS rootfs chunks: ${templateRootChunks} files`)
    } catch { console.log('  Template NFS chunks: not found') }

    // THE MEASUREMENT: Resume from pure NFS (no in-memory cache, no local SSD)
    console.log('\n--- RESUME (pure NFS, no in-memory cache) ---')
    const resumeStart = Date.now()

    const [sandbox, resumeMs] = await timed(() =>
      Sandbox.connect(sandboxId, { ...gatewayConfig, timeoutMs: 300_000 })
    )

    console.log(`  Sandbox.connect: ${secs(resumeMs)}s`)

    // First command
    const [cmdResult, cmdMs] = await timed(() =>
      sandbox.commands.run('cat /home/user/marker.txt', { timeoutMs: 30_000 })
    )
    console.log(`  First command:    ${secs(cmdMs)}s`)

    if (expectedMarker) {
      expect(cmdResult.stdout.trim()).toBe(expectedMarker)
      console.log('  Marker verified')
    } else {
      console.log(`  Marker value: ${cmdResult.stdout.trim()}`)
    }

    const totalMs = resumeMs + cmdMs
    console.log(`\n  TOTAL (connect + first cmd): ${secs(totalMs)}s`)

    // Cleanup
    console.log('\n--- Cleanup ---')
    await sandbox.kill()
    console.log('  Sandbox killed')

    try {
      execSync(
        `psql "${DB_URL}" -c "DELETE FROM sandbox_snapshots WHERE sandbox_id = '${sandboxId}';"`,
        { encoding: 'utf8', timeout: 10_000 }
      )
      console.log('  Snapshots deleted from DB')
    } catch { /* best effort */ }

    console.log(`\n${'='.repeat(60)}`)
    console.log(`  PURE NFS RESUME RESULTS`)
    console.log(`  Template: ${template.name} (${template.memory})`)
    console.log(`  `)
    console.log(`  Sandbox.connect:  ${secs(resumeMs).padStart(6)}s`)
    console.log(`  First command:    ${secs(cmdMs).padStart(6)}s`)
    console.log(`  TOTAL:            ${secs(totalMs).padStart(6)}s`)
    console.log(`${'='.repeat(60)}\n`)
  }, 600_000)
})
